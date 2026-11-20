//! TypeScript declarations of every wire type, for the `ts` feature.
//!
//! The Rust types are the only definition of the protocol: clients import the
//! generated file instead of writing the same shapes a second time, so a field
//! added here cannot be forgotten there. `tests/typescript.rs` fails when the
//! committed file differs from what [`declarations`] produces now.
//!
//! The JSON-RPC envelope ([`crate::rpc::Message`]) is generic over the method
//! set and untagged, which TypeScript cannot express faithfully from the Rust
//! side; clients write that small part by hand.

use crate::delta::{BlockKind, Delta, SessionActivity};
use crate::rpc::{
    Approval, BlobPulled, ClientRequest, Credential, EngineNotification, EngineRequest,
    Initialized, LogPushed, MessageAccepted, Outcome, Records, Rewound, RpcError, RpcErrorData,
    SessionList, SessionOpened, SessionSummary, Subscribed, ToolResult, Version,
};
use crate::{PROTOCOL_VERSION, Record, RecordBody};
use std::any::TypeId;
use std::collections::HashSet;
use ts_rs::{Config, TS, TypeVisitor};

/// Collects the declaration of a type and of everything it mentions, once
/// each.
struct Collector<'a> {
    cfg: &'a Config,
    seen: HashSet<TypeId>,
    declarations: Vec<(String, String)>,
}

impl Collector<'_> {
    fn collect<T: TS + 'static + ?Sized>(&mut self) {
        // Recursive types (a JSON value holds JSON values) would never end.
        if !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        // Containers (`Vec`, `Option`…) have no output path: they are inlined
        // where they are used, but their parameters still need declaring.
        if T::output_path().is_some() {
            let declaration = T::decl(self.cfg);
            self.declarations.push((T::ident(self.cfg), declaration));
        }
        T::visit_dependencies(self);
    }
}

impl TypeVisitor for Collector<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        self.collect::<T>();
    }
}

/// The contents of the generated TypeScript file.
pub fn declarations() -> String {
    // 64-bit integers in this protocol (seqs, millisecond timestamps, token
    // counts, micro-dollars) stay far below 2^53, and the engine emits them as
    // plain JSON numbers, so `number` is what a client actually receives.
    let cfg = Config::new().with_large_int("number");
    let mut collector = Collector {
        cfg: &cfg,
        seen: HashSet::new(),
        declarations: Vec::new(),
    };
    collector.collect::<ClientRequest>();
    collector.collect::<EngineRequest>();
    collector.collect::<EngineNotification>();
    collector.collect::<Record>();
    // Flattened into `SessionRecord`, but clients also want to name it.
    collector.collect::<RecordBody>();
    collector.collect::<Delta>();
    collector.collect::<SessionActivity>();
    collector.collect::<BlockKind>();
    collector.collect::<Initialized>();
    collector.collect::<SessionOpened>();
    collector.collect::<SessionList>();
    collector.collect::<SessionSummary>();
    collector.collect::<Records>();
    collector.collect::<Subscribed>();
    collector.collect::<MessageAccepted>();
    collector.collect::<Rewound>();
    collector.collect::<ToolResult>();
    collector.collect::<Approval>();
    collector.collect::<Credential>();
    collector.collect::<LogPushed>();
    collector.collect::<BlobPulled>();
    collector.collect::<RpcError>();
    collector.collect::<RpcErrorData>();
    collector.collect::<Outcome>();
    collector.collect::<Version>();

    let mut declarations = collector.declarations;
    declarations.sort_by(|a, b| a.0.cmp(&b.0));
    // The same declaration reached through two Rust types (a JSON value
    // behind `&` and behind `Option`, say) must appear once.
    declarations.dedup_by(|a, b| a.0 == b.0);

    let mut out = String::from(
        "// Generated from crates/blame-engine-protocol by `pnpm generate`. Do not edit.\n\n",
    );
    out.push_str(&format!(
        "export const PROTOCOL_VERSION = {PROTOCOL_VERSION};\n\n"
    ));
    for (_, declaration) in declarations {
        // The root `pnpm format` must leave this byte-for-byte as generated.
        out.push_str("// prettier-ignore\nexport ");
        out.push_str(declaration.trim_end());
        out.push_str("\n\n");
    }
    out.truncate(out.trim_end().len());
    out.push('\n');
    out
}
