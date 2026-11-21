//! A tool call knows whether the person asked for ultra mode in a message of
//! its turn, and reads it from the log.

mod common;

use blame_engine_core::testing::{Script, ScriptedProvider, World};
use blame_engine_protocol::{Delivery, UserBlock};
use common::*;
use serde_json::json;

fn world() -> World {
    World::new(ScriptedProvider::responding(|request| {
        if matches!(
            request.messages.last(),
            Some(blame_engine_core::ports::ModelMessage::ToolResults(_))
        ) {
            Script::text("done")
        } else {
            Script::tool_calls(&[("read", json!({ "path": "a" }))])
        }
    }))
}

#[tokio::test]
async fn a_call_runs_with_the_flag_of_its_turn() {
    let world = world();
    let session = create(&world).await;
    turn(&session, "no helpers").await;
    session
        .send(
            vec![
                UserBlock::Text {
                    text: "with helpers".into(),
                },
                UserBlock::Ultra,
            ],
            Delivery::Turn,
        )
        .await
        .expect("accepted");
    session.wait_idle().await;
    turn(&session, "no helpers again").await;
    let flags: Vec<bool> = world
        .tools
        .log()
        .executions
        .iter()
        .map(|call| call.ultra)
        .collect();
    assert_eq!(flags, [false, true, false], "ultra mode is per message");
}
