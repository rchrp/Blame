//! Every failure as a `ProviderError` of the right kind.
//!
//! Rig preserves the provider's reply (status, body, headers) but has no
//! typed rate-limit, overload or billing error, so the kind is read here
//! from the status and the provider's own error code, in the order that
//! disambiguates them: an Anthropic 400 can be a context overflow or an
//! empty credit balance, an OpenAI 429 a rate limit or an exhausted quota.

use blame_engine_core::ports::ProviderError;
use blame_engine_protocol::ErrorKind;
use rig_core::error::{ErrorReport, ProviderError as RigError};
use std::time::SystemTime;

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
        message: error.to_string(),
        retry_after: report.retry_after(SystemTime::now()),
    }
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
