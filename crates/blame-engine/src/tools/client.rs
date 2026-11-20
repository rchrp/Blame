//! The session's `client_tools`, run by the client through `host/tool`.

use crate::connection::{Host, HostError};
use blame_engine_core::ports::{ToolInvocation, ToolOutput, ToolProgress};
use blame_engine_protocol::ToolOutcome;
use blame_engine_protocol::rpc::{EngineRequest, ToolResult};
use tokio_util::sync::CancellationToken;

pub async fn call(
    host: &Host,
    invocation: ToolInvocation,
    _progress: ToolProgress,
    cancel: CancellationToken,
) -> ToolOutput {
    let name = invocation.name.clone();
    let request = host.request::<ToolResult>(EngineRequest::Tool {
        session: invocation.session,
        turn: invocation.turn,
        call: invocation.call,
        name: invocation.name,
        input: invocation.input,
    });
    let result = tokio::select! {
        // Dropping the request sends `$/cancel` to the client.
        () = cancel.cancelled() => {
            return ToolOutput::text(ToolOutcome::Cancelled, "Cancelled: the user interrupted the turn.");
        }
        result = request => result,
    };
    match result {
        Ok(result) => ToolOutput {
            outcome: result.outcome,
            content: result.content,
        },
        Err(HostError::NoClient) => ToolOutput::text(
            ToolOutcome::Failed,
            format!(
                "`{name}` runs in the Blame app, and no app is connected to this session right now."
            ),
        ),
        // The client may have run it before it went away.
        Err(HostError::Disconnected) => ToolOutput::text(
            ToolOutcome::Interrupted,
            format!(
                "The Blame app disconnected while `{name}` was running: whether it took effect is unknown."
            ),
        ),
        Err(error) => ToolOutput::text(ToolOutcome::Failed, format!("`{name}` failed: {error}")),
    }
}
