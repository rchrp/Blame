//! Every failure as a `ProviderError` of the right kind.
//!
//! Rig preserves the provider's reply (status, body, headers) but has no
//! typed rate-limit, overload or billing error, so the kind is read here
//! from the status and the provider's own error code, in the order that
//! disambiguates them: an Anthropic 400 can be a context overflow or an
//! empty credit balance, an OpenAI 429 a rate limit or an exhausted quota.

use crate::catalog::AuthKind;
use crate::native::Target;
use blame_engine_core::ports::ProviderError;
use blame_engine_protocol::ErrorKind;
use rig_core::error::{ErrorReport, ProviderError as RigError};
use serde_json::Value;
use std::time::SystemTime;

/// `error` reworded for the person reading the transcript: which provider,
/// which model, what went wrong in their terms, what the provider said, and
/// what to do when there is something to do.
pub(crate) fn about(error: ProviderError, target: &Target) -> ProviderError {
    let source = crate::catalog::sources::source(target.kind);
    let provider = source.name;
    let model = &target.model.model;
    let said = error.message.trim().trim_end_matches('.');
    let message = match error.kind {
        ErrorKind::ModelUnavailable => {
            let plan = if source.auth == AuthKind::Subscription {
                " with this plan"
            } else {
                ""
            };
            format!(
                "{provider} does not offer the model `{model}`{plan}. It answered: \"{said}\". \
                 Choose another model and send your message again."
            )
        }
        ErrorKind::Authentication => format!(
            "{provider} refused the credential used for `{model}`: \"{said}\". \
             Reconnect {provider} in Settings, then send your message again."
        ),
        ErrorKind::Billing => {
            format!("{provider} refused `{model}` for billing or quota reasons: \"{said}\".")
        }
        ErrorKind::RateLimited => {
            format!("{provider} is limiting requests to `{model}`: \"{said}\".")
        }
        ErrorKind::Overloaded => {
            format!("{provider} could not answer with `{model}` right now: \"{said}\".")
        }
        ErrorKind::ContextOverflow => format!(
            "The conversation no longer fits in `{model}` ({provider} answered: \"{said}\")."
        ),
        ErrorKind::Transport | ErrorKind::Stalled => {
            format!("{provider} stopped answering for `{model}`: {said}.")
        }
        ErrorKind::InvalidRequest | ErrorKind::Internal | ErrorKind::Cancelled => {
            format!("{provider} refused the request for `{model}`: \"{said}\".")
        }
    };
    ProviderError { message, ..error }
}

pub(crate) fn from_rig(error: &RigError) -> ProviderError {
    let kind = match error {
        RigError::Stalled(_) => ErrorKind::Stalled,
        // The connection failed or the reply stopped before the provider
        // ended it: the request can be sent again.
        RigError::Http(_) | RigError::Truncated => ErrorKind::Transport,
        RigError::Url(_) | RigError::Request(_) | RigError::UnsupportedOption(_) => {
            ErrorKind::InvalidRequest
        }
        RigError::ProviderResponse(_)
        | RigError::InvalidAuthentication(_)
        | RigError::CacheExpired { .. }
        | RigError::Relayed(_) => classify(&error.report()),
        _ => ErrorKind::Internal,
    };
    let report = error.report();
    ProviderError {
        kind,
        message: said(&report).unwrap_or_else(|| error.to_string()),
        retry_after: report.retry_after(SystemTime::now()),
    }
}

/// What the provider itself wrote, with its status: the `message` its
/// error body carries (every served provider nests one under `error`; the
/// ChatGPT backend says `detail`), else the body itself, shortened.
fn said(report: &ErrorReport) -> Option<String> {
    let body = report.provider_response_body()?.trim();
    let json: Option<Value> = serde_json::from_str(body).ok();
    let field = |value: &Value| -> Option<String> {
        let text = |value: &Value| value.as_str().map(str::to_owned);
        value
            .pointer("/error/message")
            .and_then(text)
            .or_else(|| value.pointer("/response/error/message").and_then(text))
            .or_else(|| value.get("detail").and_then(text))
            .or_else(|| value.get("message").and_then(text))
            .or_else(|| value.get("error").and_then(text))
    };
    let words = match json.as_ref().and_then(field) {
        Some(words) => words,
        None if body.is_empty() => return None,
        None => body.chars().take(300).collect(),
    };
    Some(match report.http_status {
        Some(status) => format!("{words} (HTTP {status})"),
        None => words,
    })
}

/// A provider that replied with an error: its status, then the code its
/// body names, then its wording.
pub(crate) fn classify(report: &ErrorReport) -> ErrorKind {
    let body = report
        .provider_response_body()
        .unwrap_or(&report.message)
        .to_ascii_lowercase();
    let code = report
        .code
        .clone()
        .or_else(|| report.provider_response.as_ref()?.machine_code())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| body.contains(phrase));
    let billing = matches!(
        code.as_str(),
        "insufficient_quota" | "billing_error" | "billing_hard_limit_reached"
    ) || says(&[
        "insufficient_quota",
        "credit balance",
        "billing",
        "exceeded your current quota",
        "payment required",
        "insufficient credits",
    ]);
    // Gemini words a per-minute limit as an exceeded quota, but says when
    // to try again; an exhausted balance gives no time.
    let exhausted = code == "insufficient_quota"
        || (billing && report.retry_after(SystemTime::now()).is_none());
    // Asked for a model the provider does not serve, or not to this
    // account or plan. Checked before authentication: OpenAI answers a
    // project without access to a model with a 403.
    if model_refused(report.http_status, &code, &body) {
        return ErrorKind::ModelUnavailable;
    }
    match report.http_status {
        Some(401 | 403) => ErrorKind::Authentication,
        Some(402) => ErrorKind::Billing,
        Some(429) if exhausted => ErrorKind::Billing,
        Some(429) => ErrorKind::RateLimited,
        Some(408) => ErrorKind::Transport,
        Some(413) => ErrorKind::ContextOverflow,
        // Anthropic's 529 and every other server-side failure: the same
        // request can succeed once the provider recovers.
        Some(500..=599) => ErrorKind::Overloaded,
        Some(_) if report.is_context_overflow() => ErrorKind::ContextOverflow,
        Some(_) if billing => ErrorKind::Billing,
        // Gemini answers a bad key with 400 INVALID_ARGUMENT.
        Some(_) if says(&["api_key_invalid", "api key not valid"]) => ErrorKind::Authentication,
        Some(_) => ErrorKind::InvalidRequest,
        // An error sent inside a stream that had already opened with a 200:
        // only its code and wording say what it is.
        None => match code.as_str() {
            "overloaded_error"
            | "api_error"
            | "server_error"
            | "unavailable"
            | "internal"
            | "server_is_overloaded" => ErrorKind::Overloaded,
            "rate_limit_error" | "rate_limit_exceeded" | "resource_exhausted" => {
                ErrorKind::RateLimited
            }
            "authentication_error"
            | "permission_error"
            | "invalid_api_key"
            | "unauthenticated"
            | "permission_denied" => ErrorKind::Authentication,
            _ if billing => ErrorKind::Billing,
            _ if report.is_context_overflow() => ErrorKind::ContextOverflow,
            "invalid_request_error" | "invalid_request" | "invalid_argument" => {
                ErrorKind::InvalidRequest
            }
            _ => from_wording(&body),
        },
    }
}

/// Each served provider's way of saying it does not serve a model:
/// Anthropic `404 not_found_error` ("model: …"), OpenAI `404
/// model_not_found`, Gemini `404 NOT_FOUND` ("models/… is not found"),
/// OpenRouter `400`/`404` ("… is not a valid model ID", "No endpoints
/// found"), the ChatGPT backend `400` ("… is not supported when using
/// Codex with a ChatGPT account").
fn model_refused(status: Option<u16>, code: &str, body: &str) -> bool {
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| body.contains(phrase));
    let named = code == "model_not_found"
        || says(&[
            "model_not_found",
            "is not a valid model",
            "invalid model",
            "unknown model",
            "model not found",
            "model is not supported",
            "model is not available",
            "not supported when using codex",
            "no endpoints found",
            "does not have access to model",
            "do not have access to the model",
            "does not exist or you do not have access",
        ]);
    match status {
        Some(404) => named || body.contains("model"),
        Some(400 | 403 | 422) | None => named,
        Some(_) => false,
    }
}

/// A failure the provider stated in a reply that otherwise completed
/// (`response.failed`, a Gemini `finishReason` of error).
pub(crate) fn from_reported(message: &str) -> ProviderError {
    let report = ErrorReport::new(rig_core::error::ErrorKind::Provider, message);
    let kind = match from_wording(&message.to_ascii_lowercase()) {
        ErrorKind::Internal if report.is_context_overflow() => ErrorKind::ContextOverflow,
        kind => kind,
    };
    ProviderError {
        kind,
        message: message.to_owned(),
        retry_after: report.retry_after(SystemTime::now()),
    }
}

fn from_wording(text: &str) -> ErrorKind {
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| text.contains(phrase));
    if says(&[
        "overloaded",
        "server_error",
        "server error",
        "unavailable",
        "try again later",
    ]) {
        ErrorKind::Overloaded
    } else if says(&["rate limit", "rate_limit", "too many requests"]) {
        ErrorKind::RateLimited
    } else if says(&["quota", "billing", "credit"]) {
        ErrorKind::Billing
    } else {
        ErrorKind::Internal
    }
}

#[cfg(test)]
mod tests;
