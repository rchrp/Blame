//! The compiler tier's port.
//!
//! JavaScript and TypeScript references, dependency declarations and the
//! import index come from the TypeScript compiler (`semantic-reference-worker.ts`,
//! `import-index.ts`), which cannot be ported: they will be answered by a
//! small Node side process behind this trait. Until it exists,
//! [`NoCompiler`] answers what the TypeScript harness answers when its
//! compiler worker cannot start.

use crate::files::WorkspaceSnapshot;
use crate::json::Json;

/// A reference query on one declaration (`SemanticReferenceRequest`).
pub struct ReferenceTarget<'a> {
    pub root: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub start: usize,
    pub end: usize,
    pub hash: &'a str,
}

/// A dependency declaration query (`DependencyDeclarationRequest`).
pub struct DeclarationTarget<'a> {
    pub root: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub hash: &'a str,
    pub offset: Option<u64>,
}

/// A compiler reply: `{status: "ok", ...}` as the worker sends it, or the
/// reason it is unavailable.
pub enum CompilerReply {
    Ok(Json),
    Unavailable(String),
}

pub trait CompilerPort: Send + Sync {
    /// `querySemanticReferences`: locations, footprint and project.
    fn references(&self, target: &ReferenceTarget<'_>) -> CompilerReply;

    /// `queryDependencyDeclaration`: a bounded read-only declaration.
    fn declaration(&self, target: &DeclarationTarget<'_>) -> CompilerReply;

    /// `ImportIndex.briefLinks`: one line naming who uses a file's exports and
    /// which tests import it, on its first whole or folded read.
    fn brief_links(
        &self,
        root: &str,
        path: &str,
        content: &[u8],
        focus: &[String],
        snapshot: &WorkspaceSnapshot,
    ) -> Option<String>;
}

/// No compiler side process: every query is unavailable, as when the
/// TypeScript harness's worker fails to start, and reads carry no links.
pub struct NoCompiler;

impl CompilerPort for NoCompiler {
    fn references(&self, _target: &ReferenceTarget<'_>) -> CompilerReply {
        CompilerReply::Unavailable("worker_failed".into())
    }

    fn declaration(&self, _target: &DeclarationTarget<'_>) -> CompilerReply {
        CompilerReply::Unavailable("worker_failed".into())
    }

    fn brief_links(
        &self,
        _root: &str,
        _path: &str,
        _content: &[u8],
        _focus: &[String],
        _snapshot: &WorkspaceSnapshot,
    ) -> Option<String> {
        None
    }
}
