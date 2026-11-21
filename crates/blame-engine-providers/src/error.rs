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
use std::time::{Duration, SystemTime};

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
        ErrorKind::Billing => format!(
            "{provider} has no credit or quota left for `{model}`: \"{said}\". \
             Add credit with {provider}, or choose another model."
        ),
        ErrorKind::UsageLimit => format!(
            "Your {provider} usage for `{model}` is used up until it resets: \"{said}\".{} \
             Choose another model, or wait for the reset.",
            error.retry_after.map(resets_in).unwrap_or_default()
        ),
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

/// " It resets in about 1 h 30 min." for a reset the provider timed.
fn resets_in(wait: Duration) -> String {
    let minutes = wait.as_secs().div_ceil(60).max(1);
    let (hours, minutes) = (minutes / 60, minutes % 60);
    let span = match (hours, minutes) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    };
    format!(" It resets in about {span}.")
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
    let retry_after = report.retry_after(SystemTime::now()).or_else(|| {
        (kind == ErrorKind::UsageLimit)
            .then(|| usage_resets_in(&report, SystemTime::now()))
            .flatten()
    });
    ProviderError {
        kind,
        message: said(&report).unwrap_or_else(|| error.to_string()),
        retry_after,
    }
}

/// When a plan's usage resets, from the ChatGPT backend's
/// `usage_limit_reached` error (`resets_in_seconds`, or `resets_at` in
/// seconds since the epoch). Claude Code says it in its words instead.
fn usage_resets_in(report: &ErrorReport, now: SystemTime) -> Option<Duration> {
    let body: Value = serde_json::from_str(report.provider_response_body()?).ok()?;
    let error = body.get("error").unwrap_or(&body);
    if let Some(seconds) = error.get("resets_in_seconds").and_then(Value::as_u64) {
        return Some(Duration::from_secs(seconds));
    }
    let at = error.get("resets_at").and_then(Value::as_u64)?;
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(at);
    at.duration_since(now).ok()
}

/// A plan's usage used up, in the words each plan uses: Claude Code's
/// "You've hit your session limit · resets 1:10am" (also weekly, and the
/// older "Claude AI usage limit reached"), the ChatGPT backend's
/// `usage_limit_reached` ("The usage limit has been reached").
fn usage_exhausted(code: &str, body: &str) -> bool {
    matches!(code, "usage_limit_reached" | "usage_not_included")
        || [
            "usage_limit_reached",
            "usage limit has been reached",
            "usage limit reached",
            "hit your session limit",
            "hit your weekly limit",
            "hit your usage limit",
            "hit your limit",
            "session limit reached",
            "weekly limit reached",
            "5-hour limit reached",
        ]
        .iter()
        .any(|phrase| body.contains(phrase))
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
    // Before the rate limit: Claude Code and the ChatGPT backend answer a
    // used-up plan with a 429 that only its wording tells apart.
    if matches!(report.http_status, Some(429) | None) && usage_exhausted(&code, &body) {
        return ErrorKind::UsageLimit;
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
    if usage_exhausted("", text) {
        ErrorKind::UsageLimit
    } else if says(&[
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
