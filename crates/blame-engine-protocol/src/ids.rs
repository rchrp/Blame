use serde::{Deserialize, Serialize};
use std::fmt;

/// Position of a record in its session, starting at 1 and never reused.
pub type Seq = u64;

macro_rules! string_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

string_id!(
    /// One conversation with one workspace. Chosen by the client or the engine.
    SessionId
);
string_id!(
    /// One user message and everything the agent does in answer to it.
    TurnId
);
string_id!(
    /// One call to the model, including each retry of it.
    RequestId
);
string_id!(
    /// One tool call. Engine-assigned so it stays unique across providers.
    ToolCallId
);
string_id!(
    /// One snapshot of the workspace that a session can be rewound to.
    CheckpointId
);
