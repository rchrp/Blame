use super::*;
use rig_core::error::ProviderError as RigError;
use rig_reqwest::reqwest;
use std::time::Duration;

fn reply(status: u16, body: &str, headers: &[(&str, &str)]) -> RigError {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).expect("name"),
            reqwest::header::HeaderValue::from_str(value).expect("value"),
        );
    }
    RigError::from_http_response(reqwest::StatusCode::from_u16(status).expect("status"), body)
        .with_response_headers(Some(map))
}

/// A provider's error payload delivered inside a stream that opened with
/// a 200, which carries no status of its own.
fn in_stream(body: &str) -> RigError {
    RigError::from_provider_body(body)
}

#[test]
fn http_replies_are_classified_by_status_code_and_wording() {
    let anthropic = |kind: &str, message: &str| {
        serde_json::json!({"type": "error", "error": {"type": kind, "message": message}})
            .to_string()
    };
    let openai = |code: &str, message: &str| {
        serde_json::json!({"error": {"code": code, "type": code, "message": message}}).to_string()
    };
    let gemini = |code: u16, status: &str, message: &str| {
        serde_json::json!({"error": {"code": code, "status": status, "message": message}})
            .to_string()
    };
    let table: &[(u16, String, ErrorKind)] = &[
        (
            429,
            anthropic(
                "rate_limit_error",
                "Number of request tokens has exceeded your per-minute rate limit",
            ),
            ErrorKind::RateLimited,
        ),
        (
            529,
            anthropic("overloaded_error", "Overloaded"),
            ErrorKind::Overloaded,
        ),
        (
            500,
            anthropic("api_error", "Internal server error"),
            ErrorKind::Overloaded,
        ),
        (
            503,
            gemini(503, "UNAVAILABLE", "The model is overloaded."),
            ErrorKind::Overloaded,
        ),
        (
            400,
            anthropic(
                "invalid_request_error",
                "prompt is too long: 210000 tokens > 200000 maximum",
            ),
            ErrorKind::ContextOverflow,
        ),
        (
            400,
            openai(
                "context_length_exceeded",
                "This model's maximum context length is 128000 tokens.",
            ),
            ErrorKind::ContextOverflow,
        ),
        (
            400,
            gemini(
                400,
                "INVALID_ARGUMENT",
                "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
            ),
            ErrorKind::ContextOverflow,
        ),
        (
            413,
            anthropic(
                "request_too_large",
                "Request exceeds the maximum allowed number of bytes.",
            ),
            ErrorKind::ContextOverflow,
        ),
        (
            401,
            anthropic("authentication_error", "invalid x-api-key"),
            ErrorKind::Authentication,
        ),
        (
            403,
            gemini(
                403,
                "PERMISSION_DENIED",
                "Method doesn't allow unregistered callers.",
            ),
            ErrorKind::Authentication,
        ),
        (
            400,
            anthropic(
                "invalid_request_error",
                "Your credit balance is too low to access the Anthropic API.",
            ),
            ErrorKind::Billing,
        ),
        (
            402,
            openai("payment_required", "Insufficient credits."),
            ErrorKind::Billing,
        ),
        (
            429,
            openai(
                "insufficient_quota",
                "You exceeded your current quota, please check your plan and billing details.",
            ),
            ErrorKind::Billing,
        ),
        (
            400,
            anthropic(
                "invalid_request_error",
                "tools.0.name: String should match pattern",
            ),
            ErrorKind::InvalidRequest,
        ),
        (
            404,
            openai("model_not_found", "The model `gpt-9` does not exist."),
            ErrorKind::ModelUnavailable,
        ),
        (
            404,
            anthropic("not_found_error", "model: claude-next-9"),
            ErrorKind::ModelUnavailable,
        ),
        (
            404,
            gemini(
                404,
                "NOT_FOUND",
                "models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.",
            ),
            ErrorKind::ModelUnavailable,
        ),
        (
            400,
            serde_json::json!({"error": {"code": 400, "message": "acme/next is not a valid model ID"}})
                .to_string(),
            ErrorKind::ModelUnavailable,
        ),
        (
            403,
            openai(
                "model_not_found",
                "Project `proj_1` does not have access to model `gpt-9`",
            ),
            ErrorKind::ModelUnavailable,
        ),
        (
            400,
            serde_json::json!({"detail": "The 'gpt-9' model is not supported when using Codex with a ChatGPT account."})
                .to_string(),
            ErrorKind::ModelUnavailable,
        ),
        // A wrong base URL is not a missing model.
        (404, "404 page not found".to_owned(), ErrorKind::InvalidRequest),
        (408, String::new(), ErrorKind::Transport),
    ];
    for (status, body, expected) in table {
        let error = from_rig(&reply(*status, body, &[]));
        assert_eq!(error.kind, *expected, "{status} {body}");
    }
}

#[test]
fn a_rate_limit_says_how_long_to_wait() {
    let anthropic = reply(429, "{}", &[("retry-after", "7")]);
    assert_eq!(
        from_rig(&anthropic).retry_after,
        Some(Duration::from_secs(7))
    );
    let openai = reply(429, "{}", &[("retry-after-ms", "1500")]);
    assert_eq!(
        from_rig(&openai).retry_after,
        Some(Duration::from_millis(1500))
    );
    // Gemini words a per-minute limit as an exhausted quota but names the
    // wait in its body: a rate limit, not a billing problem.
    let gemini = reply(
        429,
        r#"{"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "You exceeded your current quota, please check your plan and billing details.", "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "21s"}]}}"#,
        &[],
    );
    let error = from_rig(&gemini);
    assert_eq!(error.kind, ErrorKind::RateLimited);
    assert_eq!(error.retry_after, Some(Duration::from_secs(21)));
}

#[test]
fn errors_inside_a_stream_are_classified_by_their_code() {
    let table = [
        (
            r#"{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}"#,
            ErrorKind::Overloaded,
        ),
        (
            r#"{"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}"#,
            ErrorKind::RateLimited,
        ),
        (
            r#"{"type": "error", "error": {"type": "api_error", "message": "Internal server error"}}"#,
            ErrorKind::Overloaded,
        ),
        (
            r#"{"type": "error", "error": {"type": "invalid_request_error", "message": "prompt is too long"}}"#,
            ErrorKind::ContextOverflow,
        ),
        (
            r#"{"type": "response.failed", "response": {"error": {"code": "server_error", "message": "An error occurred"}}}"#,
            ErrorKind::Overloaded,
        ),
        (
            r#"{"error": {"code": "rate_limit_exceeded", "message": "Rate limit reached"}}"#,
            ErrorKind::RateLimited,
        ),
        (
            r#"{"error": {"code": "insufficient_quota", "message": "You exceeded your current quota"}}"#,
            ErrorKind::Billing,
        ),
    ];
    for (body, expected) in table {
        assert_eq!(from_rig(&in_stream(body)).kind, expected, "{body}");
    }
}

#[test]
fn failures_without_a_provider_reply() {
    assert_eq!(from_rig(&RigError::Truncated).kind, ErrorKind::Transport);
    assert_eq!(
        from_rig(&RigError::Stalled(Duration::from_secs(300))).kind,
        ErrorKind::Stalled
    );
    assert_eq!(
        from_rig(&RigError::request("no max_tokens")).kind,
        ErrorKind::InvalidRequest
    );
    assert_eq!(
        from_rig(&RigError::Provider("bug".into())).kind,
        ErrorKind::Internal
    );
    assert_eq!(
        from_reported("The server is overloaded").kind,
        ErrorKind::Overloaded
    );
    assert_eq!(
        from_reported("prompt is too long").kind,
        ErrorKind::ContextOverflow
    );
}

/// The messages the owner's runs got, and the ChatGPT plan's: a used-up
/// plan is not a rate limit, is not retried, and keeps what the provider
/// said (which limit, when it resets).
#[test]
fn a_used_up_plan_is_told_apart_from_a_rate_limit() {
    let anthropic = |kind: &str, message: &str| {
        serde_json::json!({"type": "error", "error": {"type": kind, "message": message}})
            .to_string()
    };
    for message in [
        "You've hit your session limit · resets 1:10am (Europe/Bucharest)",
        "You've hit your weekly limit · resets Mon 9am (Europe/Bucharest)",
        "Claude AI usage limit reached|1795180000",
    ] {
        let error = from_rig(&reply(429, &anthropic("rate_limit_error", message), &[]));
        assert_eq!(error.kind, ErrorKind::UsageLimit, "{message}");
        assert!(!error.kind.is_retryable());
        assert!(error.message.starts_with(message), "{}", error.message);
    }
    let chatgpt = reply(
        429,
        r#"{"error": {"type": "usage_limit_reached", "message": "The usage limit has been reached", "plan_type": "plus", "resets_in_seconds": 5400}}"#,
        &[],
    );
    let error = from_rig(&chatgpt);
    assert_eq!(error.kind, ErrorKind::UsageLimit);
    assert_eq!(error.retry_after, Some(Duration::from_secs(5400)));
    assert_eq!(error.message, "The usage limit has been reached (HTTP 429)");
    let at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("now")
        .as_secs()
        + 600;
    let chatgpt_at = reply(
        429,
        &format!(
            r#"{{"detail": {{"code": "usage_limit_reached"}}, "error": {{"type": "usage_limit_reached", "message": "The usage limit has been reached", "resets_at": {at}}}}}"#
        ),
        &[],
    );
    let wait = from_rig(&chatgpt_at).retry_after.expect("reset");
    assert!(wait <= Duration::from_secs(600) && wait > Duration::from_secs(590));
    // A per-minute limit stays a rate limit, retried after its wait.
    let minute = from_rig(&reply(
        429,
        &anthropic(
            "rate_limit_error",
            "Number of request tokens has exceeded your per-minute rate limit",
        ),
        &[("retry-after", "7")],
    ));
    assert_eq!(minute.kind, ErrorKind::RateLimited);
    // An API key out of credit is billing: not a plan that resets.
    let credit = from_rig(&reply(
        400,
        &anthropic(
            "invalid_request_error",
            "Your credit balance is too low to access the Anthropic API.",
        ),
        &[],
    ));
    assert_eq!(credit.kind, ErrorKind::Billing);
    let quota = from_rig(&reply(
        429,
        r#"{"error": {"code": "insufficient_quota", "type": "insufficient_quota", "message": "You exceeded your current quota, please check your plan and billing details."}}"#,
        &[],
    ));
    assert_eq!(quota.kind, ErrorKind::Billing);
    // Said inside a reply that otherwise completed, too.
    assert_eq!(
        from_reported("You've hit your session limit · resets 1:10am").kind,
        ErrorKind::UsageLimit
    );
}
