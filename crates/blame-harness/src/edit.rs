//! edit_code (`light-edit.ts`): symbol actions, file patches, scoped patches
//! and compiler renames, planned against the original source of each file,
//! validated as final content, then committed atomically.

use crate::aliases::{Alias, AliasRegistry, ResolvedSymbol};
use crate::commit::{CommitResult, Mutation, commit};
use crate::compiler::{CompilerPort, CompilerReply, ReferenceTarget, footprint_is_current};
use crate::failure::{Failure, Outcome, Signal};
use crate::files::{WorkspaceFiles, WorkspaceSnapshot};
use crate::identity::sha256_hex;
use crate::journal::SessionJournal;
use crate::json::Json;
use crate::languages::capability_for_path;
use crate::obj;
use crate::patch::{
    PatchPlan, Replacement, complete_new_file_patch, has_cline_patch_envelope, plan_light_patch,
    plan_scoped_light_patch, split_light_patch,
};
use crate::read_results::base36;
use crate::symbol_edit::{SourcedReplacement, symbol_replacement, symbols_touched};
use crate::syntax::{parse_code, symbol_edit_range};
use crate::text::{js_trim_end, utf16_prefix};
use crate::validation::validate_content;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq)]
enum FileMutation {
    Add,
    Delete,
}

struct BodyHeader {
    target: String,
    qualified_name: String,
    header: String,
    truncated: bool,
}

struct PlannedFile {
    body_targets: Vec<String>,
    body_headers: Vec<BodyHeader>,
    footprint: Option<Json>,
    semantic_rename: Option<Json>,
    file_mode: Option<u32>,
    initial: Option<Arc<Vec<u8>>>,
    mutation: Option<FileMutation>,
    path: String,
    replacements: Vec<SourcedReplacement>,
    symbols: Vec<String>,
}

struct FinalFile {
    plan: PlannedFile,
    content: Option<Vec<u8>>,
    parse_status: String,
    diagnostics: Vec<String>,
}

/// One edit_code operation, validated.
pub struct Operation {
    pub kind: String,
    pub target: Option<String>,
    pub action: Option<String>,
    pub content: Option<String>,
    pub path: Option<String>,
    pub patch: Option<String>,
}

impl Operation {
    pub fn from_json(value: &Json) -> Operation {
        let text = |key: &str| value.get(key).and_then(Json::as_str).map(str::to_string);
        Operation {
            kind: text("kind").unwrap_or_default(),
            target: text("target"),
            action: text("action"),
            content: text("content"),
            path: text("path"),
            patch: text("patch"),
        }
    }
}

/// The edit state a workspace keeps between calls.
#[derive(Default)]
pub struct EditService {
    receipt_sequence: usize,
    last_noop_body_key: Option<String>,
}

pub struct EditContext<'a> {
    pub files: &'a WorkspaceFiles,
    pub aliases: &'a mut AliasRegistry,
    pub journal: &'a mut SessionJournal,
    pub compiler: &'a dyn CompilerPort,
    pub signal: &'a Signal,
}

fn diagnostic_id() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("edit-{}", base36(elapsed))
}

impl EditService {
    pub fn edit(
        &mut self,
        operations: &[Operation],
        context: &mut EditContext<'_>,
    ) -> Outcome<Json> {
        let outcome = (|| {
            let snapshot = context.files.snapshot(context.signal)?;
            let plans = self.plan(operations, &snapshot, context)?;
            self.apply_plans(plans, &snapshot, context)
        })();
        match outcome {
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(edit_failure(&failure)),
            Ok(result) => Ok(result),
        }
    }

    fn apply_plans(
        &mut self,
        plans: Vec<PlannedFile>,
        snapshot: &WorkspaceSnapshot,
        context: &mut EditContext<'_>,
    ) -> Outcome<Json> {
        let footprint = plans.iter().find_map(|plan| plan.footprint.clone());
        let rename = plans.iter().find_map(|plan| plan.semantic_rename.clone());
        let files = finalize(plans, context)?;
        if let Some(footprint) = footprint
            && !footprint_is_current(&footprint, context.signal)?
        {
            return Err(Failure::conflict(
                "Semantic rename source or dependency changed before commit.",
            ));
        }
        if let Some(invalid) = files.iter().find(|file| file.parse_status == "failed") {
            let mut result = invalid_parse_result(invalid);
            result.extend(body_edit_context(&files));
            return Ok(result);
        }
        let mutations: Vec<Mutation> = files
            .iter()
            .map(|file| Mutation {
                after: file.content.clone(),
                before: file.plan.initial.as_ref().map(|initial| initial.to_vec()),
                mode: file.plan.file_mode,
                path: file.plan.path.clone(),
            })
            .collect();
        let committed = match commit(
            context.files,
            &mutations,
            &snapshot.revision.source_revision_id,
            context.signal,
        ) {
            Ok(committed) => committed,
            Err(failure) if failure.cancelled => return Err(failure),
            Err(failure) => return Ok(commit_failure(&failure)),
        };
        let mapped = self.map_result(&committed, &files, snapshot, context);
        let mut mapped = match mapped {
            Ok(mapped) => mapped,
            Err(failure) if failure.cancelled => return Err(failure),
            Err(failure) => {
                return Ok(obj! {
                    "status" => "failed",
                    "category" => "harness",
                    "applied" => true,
                    "recovery" => "recovery_required",
                    "paths" => Json::Arr(committed.changed_paths.iter().map(Json::from).collect()),
                    "message" => format!("Files were committed but the receipt could not be persisted. Do not replay this batch. {}", failure.message),
                    "diagnosticId" => diagnostic_id(),
                });
            }
        };
        if let Some(mut rename) = rename
            && mapped.get("status").and_then(Json::as_str) == Some("ok")
        {
            rename.set("engine", "typescript_language_service");
            rename.set("scope", "configured_project");
            rename.set("staticGuard", "no_new_diagnostics_in_changed_files");
            rename.set("guidance", "Applied the listed compiler-derived binding edits. An import/export's source-side name and namespace property follow the renamed declaration; explicit local/public alias spellings stay unchanged. Examples show individual identifier edits, not a complete diff. Inspect read_code @changes or the final diff before further edits; remaining textual homonyms/comments/literals need not be renamed. Static checks do not establish behavioral equivalence or satisfy required test/validation criteria; run required checks after editing.");
            if let Some(data) = mapped.get_mut("data") {
                data.set("semanticRename", rename);
            }
        }
        Ok(mapped)
    }

    fn plan(
        &mut self,
        operations: &[Operation],
        snapshot: &WorkspaceSnapshot,
        context: &mut EditContext<'_>,
    ) -> Outcome<Vec<PlannedFile>> {
        if let Some(rename) = operations.iter().find(|operation| {
            operation.kind == "symbol" && operation.action.as_deref() == Some("rename")
        }) {
            if operations.len() != 1 {
                return Err(Failure::new(
                    "Semantic rename must be the only operation in a batch.",
                ));
            }
            return plan_rename(rename, snapshot, context);
        }
        let mut plans: Vec<PlannedFile> = Vec::new();
        let mut count = 0usize;
        for operation in operations {
            if operation.kind == "patch" {
                if operation.target.is_some() {
                    count += 1;
                    if count > 50 {
                        return Err(Failure::new("Edit batch contains too many operations."));
                    }
                    plan_scoped_patch(&mut plans, operation, context)?;
                    continue;
                }
                count += plan_patch(
                    &mut plans,
                    operation.path.as_deref(),
                    operation.patch.as_deref().unwrap_or(""),
                    50 - count,
                    context,
                )?;
            } else {
                if count >= 50 {
                    return Err(Failure::new("Edit batch contains too many operations."));
                }
                count += 1;
                plan_symbol(&mut plans, operation, context)?;
            }
        }
        for plan in &plans {
            assert_compatible_mutations(plan)?;
        }
        Ok(plans)
    }

    fn map_result(
        &mut self,
        committed: &CommitResult,
        files: &[FinalFile],
        snapshot: &WorkspaceSnapshot,
        context: &mut EditContext<'_>,
    ) -> Outcome<Json> {
        if committed.changed_paths.is_empty() {
            let targets: Vec<Json> = files
                .iter()
                .flat_map(|file| file.plan.body_targets.iter().map(Json::from))
                .collect();
            let key = Json::Arr(vec![
                Json::from(snapshot.revision.source_revision_id.as_str()),
                Json::Arr(targets),
            ])
            .stringify();
            let repeated = self.last_noop_body_key.as_deref() == Some(key.as_str())
                && files.iter().any(|file| !file.plan.body_targets.is_empty());
            self.last_noop_body_key = Some(key);
            let mut data = obj! { "changed" => false, "parse" => parse_summary(files) };
            data.extend(body_edit_context(files));
            if repeated {
                let mut seen: Vec<String> = Vec::new();
                for target in files.iter().flat_map(|file| file.plan.body_targets.iter()) {
                    if !seen.contains(target) {
                        seen.push(target.clone());
                    }
                }
                data.set("guidance", "The observed body already matches. replace_body preserves parameters, return type and imports. To change them, read the complete declaration/file and use replace or a file patch; do not repeat this body edit.");
                data.set(
                    "nextReads",
                    Json::Arr(
                        seen.iter()
                            .map(|target| obj! { "target" => target.as_str(), "view" => "symbol" })
                            .collect(),
                    ),
                );
            }
            return Ok(obj! { "status" => "ok", "data" => data });
        }
        self.last_noop_body_key = None;
        self.receipt_sequence += 1;
        let receipt = format!("c{}", self.receipt_sequence);
        let parse = parse_summary(files);
        let mut symbols: Vec<String> = Vec::new();
        for symbol in files.iter().flat_map(|file| file.plan.symbols.iter()) {
            if !symbols.contains(symbol) {
                symbols.push(symbol.clone());
            }
        }
        let before_files: Vec<Json> = files
            .iter()
            .map(|file| obj! { "path" => file.plan.path.as_str(), "hash" => file.plan.initial.as_ref().map_or("absent".to_string(), |initial| sha256_hex(initial)) })
            .collect();
        context.journal.record_change(
            context.files,
            obj! {
                "beforeFiles" => Json::Arr(before_files),
                "paths" => Json::Arr(committed.changed_paths.iter().map(Json::from).collect()),
                "receipt" => receipt.as_str(),
                "sourceRevisionId" => committed.source_revision_id.as_str(),
                "symbols" => Json::Arr(symbols.iter().map(Json::from).collect()),
                "parse" => if parse.get("status").and_then(Json::as_str) == Some("passed") { "passed" } else { "not_supported" },
            },
        )?;
        let aliases = refresh_aliases(&committed.changed_paths, &symbols, context)?;
        context.journal.record_aliases(context.aliases.entries())?;
        let mut data = obj! { "changed" => true, "changes" => Json::Arr(files.iter().map(file_change).collect()) };
        if !aliases.is_empty() {
            data.set("aliases", Json::Arr(aliases));
        }
        data.set("parse", parse);
        data.set(
            "basedOn",
            if snapshot.git {
                "worktree"
            } else {
                "filesystem"
            },
        );
        data.set("sourceRevisionId", committed.source_revision_id.as_str());
        data.extend(body_edit_context(files));
        Ok(obj! { "status" => "ok", "receipt" => receipt, "data" => data })
    }
}

fn optional_file(files: &WorkspaceFiles, path: &str) -> Outcome<Option<crate::files::ReadFile>> {
    match files.read(path) {
        Ok(file) => Ok(Some(file)),
        Err(failure) if failure.is_missing() => Ok(None),
        Err(failure) => Err(failure),
    }
}

fn file_plan<'p>(
    plans: &'p mut Vec<PlannedFile>,
    path: &str,
    known: Option<Arc<Vec<u8>>>,
    files: &WorkspaceFiles,
) -> Outcome<&'p mut PlannedFile> {
    if let Some(index) = plans.iter().position(|plan| plan.path == path) {
        return Ok(&mut plans[index]);
    }
    let file = optional_file(files, path)?;
    let file_mode = file.as_ref().map(|file| file.mode);
    let initial = known.or_else(|| file.map(|file| Arc::new(file.content)));
    plans.push(PlannedFile {
        body_targets: Vec::new(),
        body_headers: Vec::new(),
        footprint: None,
        semantic_rename: None,
        file_mode,
        initial,
        mutation: None,
        path: path.to_string(),
        replacements: Vec::new(),
        symbols: Vec::new(),
    });
    Ok(plans.last_mut().expect("plan"))
}

fn plain(replacements: &[SourcedReplacement]) -> Vec<Replacement> {
    replacements
        .iter()
        .map(|item| Replacement {
            start: item.start,
            end: item.end,
            replacement: item.replacement.clone(),
        })
        .collect()
}

fn plan_patch(
    plans: &mut Vec<PlannedFile>,
    requested: Option<&str>,
    patch: &str,
    remaining: usize,
    context: &mut EditContext<'_>,
) -> Outcome<usize> {
    let normalized = match requested {
        Some(requested) if !has_cline_patch_envelope(patch) => {
            let path = context.files.normalize_path(requested)?;
            if plans.iter().any(|plan| plan.path == path)
                || optional_file(context.files, &path)?.is_some()
            {
                patch.to_string()
            } else {
                complete_new_file_patch(&path, patch)
            }
        }
        _ => patch.to_string(),
    };
    let operations = split_light_patch(&normalized, requested)?;
    if operations.len() > remaining {
        return Err(Failure::new("Edit batch contains too many operations."));
    }
    for (path, patch) in &operations {
        let path = context.files.normalize_path(path)?;
        let file = file_plan(plans, &path, None, context.files)?;
        let source = file
            .initial
            .as_ref()
            .map(|initial| String::from_utf8_lossy(initial).into_owned());
        let plan = plan_light_patch(&context.files.root, &path, source.as_deref(), patch)?;
        if let PatchPlan::Update(replacements) = &plan {
            let touched = symbols_touched(
                &path,
                file.initial.as_deref().map(Vec::as_slice),
                replacements,
            );
            file.symbols.extend(touched);
        }
        apply_patch_plan(file, &path, plan)?;
    }
    Ok(operations.len())
}

fn apply_patch_plan(file: &mut PlannedFile, path: &str, plan: PatchPlan) -> Outcome<()> {
    match plan {
        PatchPlan::Add(content) => {
            if file.initial.is_some() && file.mutation == Some(FileMutation::Delete) {
                if !file.replacements.is_empty() {
                    return Err(Failure::new(format!(
                        "File replacement cannot overlap another edit in {path}."
                    )));
                }
                file.mutation = None;
                let end = file.initial.as_ref().map_or(0, |initial| initial.len());
                file.replacements.push(SourcedReplacement {
                    start: 0,
                    end,
                    replacement: content,
                    source: format!("replace {path}"),
                });
                return Ok(());
            }
            if file.initial.is_some() {
                return Err(Failure::new(format!("{path} already exists.")));
            }
            file.mutation = Some(FileMutation::Add);
            file.replacements.push(SourcedReplacement {
                start: 0,
                end: 0,
                replacement: content,
                source: format!("add {path}"),
            });
        }
        PatchPlan::Delete => {
            if file.initial.is_none() {
                return Err(Failure::new(format!("{path} does not exist.")));
            }
            file.mutation = Some(FileMutation::Delete);
        }
        PatchPlan::Update(replacements) => {
            file.replacements
                .extend(
                    replacements
                        .into_iter()
                        .map(|replacement| SourcedReplacement {
                            start: replacement.start,
                            end: replacement.end,
                            replacement: replacement.replacement,
                            source: format!("patch {path}"),
                        }),
                );
        }
    }
    Ok(())
}

fn plan_symbol(
    plans: &mut Vec<PlannedFile>,
    operation: &Operation,
    context: &mut EditContext<'_>,
) -> Outcome<()> {
    let target = operation.target.clone().unwrap_or_default();
    let action = operation.action.clone().unwrap_or_default();
    let resolved = context.aliases.resolve_for_edit(&target, context.files)?;
    if !capability_for_path(&resolved.path).is_some_and(|capability| capability.loaded) {
        return Err(Failure::symbol(
            format!("Symbol editing is unavailable for {}.", resolved.path),
            Vec::new(),
        ));
    }
    if ["replace", "replace_body", "delete"].contains(&action.as_str()) {
        let range = if action == "replace_body" {
            symbol_edit_range(&resolved.symbol, "body")
        } else {
            resolved.symbol.range
        };
        context.aliases.assert_observed(
            resolved.alias.as_deref(),
            (
                range.0 - resolved.symbol.range.0,
                range.1 - resolved.symbol.range.0,
            ),
        )?;
    }
    let replacement =
        symbol_replacement(&resolved, &action, &target, operation.content.as_deref())?;
    let file = file_plan(
        plans,
        &resolved.path,
        Some(resolved.content.clone()),
        context.files,
    )?;
    file.symbols.push(resolved.symbol.qualified_name.clone());
    file.replacements.push(replacement);
    if action == "replace_body" {
        file.body_targets
            .push(resolved.alias.clone().unwrap_or_else(|| target.clone()));
        let (start, end) = symbol_edit_range(&resolved.symbol, "signature");
        let header =
            js_trim_end(&String::from_utf8_lossy(&resolved.content[start..end])).to_string();
        let compact: String = header.chars().take(512).collect();
        file.body_headers.push(BodyHeader {
            target: target.clone(),
            qualified_name: resolved.symbol.qualified_name.clone(),
            truncated: compact != header,
            header: compact,
        });
    }
    Ok(())
}

fn plan_scoped_patch(
    plans: &mut Vec<PlannedFile>,
    operation: &Operation,
    context: &mut EditContext<'_>,
) -> Outcome<()> {
    let target = operation.target.clone().unwrap_or_default();
    if context.aliases.get(&target).is_none() {
        return Err(Failure::symbol(
            "A scoped patch requires an observed symbol alias.",
            Vec::new(),
        ));
    }
    let resolved = context.aliases.resolve_for_edit(&target, context.files)?;
    let patch = operation.patch.clone().unwrap_or_default();
    match plan_resolved_scoped_patch(plans, operation, &patch, &resolved, context) {
        Ok(()) => Ok(()),
        Err(ScopedError::Shape(correction, message)) => {
            Err(scoped_recovery(&message, &resolved, Some(correction)))
        }
        Err(ScopedError::Other(failure)) if failure.cancelled => Err(failure),
        Err(ScopedError::Other(failure)) => {
            let correction = scoped_context_correction(&patch, &resolved, &failure.message);
            Err(scoped_recovery(&failure.message, &resolved, correction))
        }
    }
}

enum ScopedError {
    Shape(Json, String),
    Other(Failure),
}

impl From<Failure> for ScopedError {
    fn from(failure: Failure) -> Self {
        ScopedError::Other(failure)
    }
}

fn plan_resolved_scoped_patch(
    plans: &mut Vec<PlannedFile>,
    operation: &Operation,
    patch: &str,
    resolved: &ResolvedSymbol,
    context: &mut EditContext<'_>,
) -> Result<(), ScopedError> {
    let sections = split_light_patch(patch, None)?;
    let header_matches =
        sections.len() == 1 && context.files.normalize_path(&sections[0].0)? == resolved.path;
    let path_matches = match &operation.path {
        Some(path) => context.files.normalize_path(path)? == resolved.path,
        None => true,
    };
    if !header_matches || !path_matches {
        let paths: Vec<String> = sections.iter().map(|(path, _)| path.clone()).collect();
        return Err(ScopedError::Shape(
            shape_correction(&resolved.path, &paths, operation.path.as_deref()),
            "Scoped patch header must match the symbol's file and contain one Update File.".into(),
        ));
    }
    let (start, end) = resolved.symbol.range;
    let source = String::from_utf8_lossy(&resolved.content[start..end]).into_owned();
    let replacements = plan_scoped_light_patch(&source, &sections[0].1, &resolved.path)?;
    let file = file_plan(
        plans,
        &resolved.path,
        Some(resolved.content.clone()),
        context.files,
    )?;
    file.symbols.push(resolved.symbol.qualified_name.clone());
    let alias = resolved.alias.clone().unwrap_or_default();
    for replacement in &replacements {
        context.aliases.assert_observed(
            resolved.alias.as_deref(),
            (replacement.start, replacement.end),
        )?;
        if replacement.start == replacement.end
            && (replacement.start == 0 || replacement.end == end - start)
        {
            return Err(Failure::new(
                "Use insert_before or insert_after for a symbol boundary insertion.",
            )
            .into());
        }
        file.replacements.push(SourcedReplacement {
            start: start + replacement.start,
            end: start + replacement.end,
            replacement: replacement.replacement.clone(),
            source: format!("patch {alias}"),
        });
    }
    let mut scoped = resolved.content[start..end].to_vec();
    for replacement in replacements.iter().rev() {
        scoped.splice(
            replacement.start..replacement.end,
            replacement.replacement.bytes(),
        );
    }
    let mut candidate = resolved.content[..start].to_vec();
    candidate.extend_from_slice(&scoped);
    candidate.extend_from_slice(&resolved.content[end..]);
    let parsed = parse_code(&resolved.path, &candidate);
    let boundary = parsed
        .symbols
        .iter()
        .filter(|symbol| {
            symbol.kind == resolved.symbol.kind
                && symbol.range.0 == start
                && symbol.range.1 == start + scoped.len()
        })
        .count();
    if boundary != 1 {
        return Err(Failure::symbol(
            "Scoped patch changes a declaration boundary; use an explicit symbol action.",
            Vec::new(),
        )
        .into());
    }
    Ok(())
}

fn shape_correction(expected: &str, paths: &[String], supplied: Option<&str>) -> Json {
    let repeated = paths.len() > 1 && paths.iter().all(|path| *path == paths[0]);
    let reason = if repeated {
        "multiple_headers_for_symbol"
    } else if paths.len() != 1 {
        "multiple_files_for_symbol"
    } else {
        "wrong_file_for_symbol"
    };
    obj! {
        "reason" => reason,
        "expectedPath" => expected,
        "patchPaths" => Json::Arr(paths.iter().take(8).map(Json::from).collect()),
        "patchPathCount" => paths.len(),
    }
    .with_opt("suppliedPath", supplied)
    .with("symbolRoute", "Keep target and use one operation per observed symbol, each with one matching Update File. Split unrelated file changes into separate operations in the same atomic batch.")
    .with("fileRoute", "Review and read all intended file changes first. For a deliberate file patch, omit target; explicit file headers select the files. This changes the scope of your request and is never done automatically. Exact preimages and atomic batch guards still apply.")
}

/// `scopedContextCorrection`: a context that matches the whole file, not the symbol.
fn scoped_context_correction(
    patch: &str,
    resolved: &ResolvedSymbol,
    message: &str,
) -> Option<Json> {
    if !message.to_lowercase().contains("context does not match")
        || resolved.content.len() > 512 * 1024
        || patch.len() > 32 * 1024
    {
        return None;
    }
    let text = String::from_utf8_lossy(&resolved.content).into_owned();
    let replacements = plan_scoped_light_patch(&text, patch, &resolved.path).ok()?;
    if replacements.is_empty() {
        return None;
    }
    let (start, end) = resolved.symbol.range;
    let outside: Vec<&Replacement> = replacements
        .iter()
        .filter(|replacement| replacement.start < start || replacement.end > end)
        .collect();
    let line_at = |offset: usize| {
        String::from_utf8_lossy(&resolved.content[..offset])
            .split('\n')
            .count()
    };
    let lines = |replacement: &Replacement| {
        (
            line_at(replacement.start),
            line_at(replacement.start.max(replacement.end.saturating_sub(1))),
        )
    };
    let first = lines(outside.first().copied().unwrap_or(&replacements[0])).0;
    let total = text.split('\n').count();
    let start_line = first.saturating_sub(3).max(1);
    Some(obj! {
        "reason" => "context_outside_symbol",
        "expectedPath" => resolved.path.as_str(),
        "affectedLines" => Json::Arr(replacements.iter().take(8).map(|replacement| Json::from(lines(replacement))).collect()),
        "affectedRangeCount" => replacements.len(),
        "changesOutsideSymbol" => !outside.is_empty(),
        "nextRead" => obj! { "target" => resolved.path.as_str(), "view" => "range", "range" => obj! { "startLine" => start_line, "endLine" => total.min(start_line + 24) } },
    })
}

/// `ScopedEditRecovery`.
fn scoped_recovery(message: &str, resolved: &ResolvedSymbol, correction: Option<Json>) -> Failure {
    let context_correction = correction
        .as_ref()
        .filter(|correction| correction.get("affectedLines").is_some());
    let (start_line, end_line) = resolved.symbol.line_range;
    let mut recovery = String::from(
        "No operations in this batch were applied. Every operation uses the original source, not earlier operations in the same batch. ",
    );
    if context_correction.is_some() {
        recovery.push_str("The exact context matches the file; resending it with this same narrow target cannot fix the scope conflict. Narrow the patch context or explicitly choose a file patch after inspecting the affected lines. Other edit guards still apply. ");
    } else if let Some(hint) = patch_failure_recovery(message) {
        recovery.push_str(hint);
        recovery.push(' ');
    }
    let next_read = context_correction.and_then(|correction| correction.get("nextRead").cloned()).unwrap_or_else(|| {
        obj! {
            "target" => resolved.path.as_str(),
            "view" => "range",
            "range" => obj! { "startLine" => start_line.saturating_sub(3).max(1), "endLine" => (end_line + 2).min(start_line + 24) },
        }
    });
    let details = obj! { "target" => resolved.alias.as_deref().map_or(Json::Null, Json::from), "path" => resolved.path.as_str() }
        .with_opt("patchCorrection", correction.clone())
        .with("declarationLines", Json::from((start_line, end_line)))
        .with("nextRead", next_read)
        .with("routes", "Read the current text before retrying. For changes inside the declaration, read the symbol then use a symbol action or a focused alias patch. For JSDoc, export wrappers or context outside it, read those lines and use a file patch. For dependent edits, commit separately and read again. These locations are hints, not observed edit coverage; refresh after source changes.");
    recovery.push_str(&details.stringify());
    let text = if context_correction.is_some() {
        "Patch context matches the whole file but exceeds the selected symbol scope."
    } else {
        message
    };
    Failure {
        recovery: Some(recovery),
        ..Failure::new(text)
    }
}

fn plan_rename(
    operation: &Operation,
    snapshot: &WorkspaceSnapshot,
    context: &mut EditContext<'_>,
) -> Outcome<Vec<PlannedFile>> {
    let _ = snapshot;
    let target = operation.target.clone().unwrap_or_default();
    let new_name = operation.content.clone().unwrap_or_default();
    let resolved = context.aliases.resolve_for_edit(&target, context.files)?;
    let (start, end) = resolved.symbol.range;
    context
        .aliases
        .assert_observed(resolved.alias.as_deref(), (0, end - start))?;
    if !capability_for_path(&resolved.path).is_some_and(|capability| {
        ["typescript", "tsx", "javascript", "jsx"].contains(&capability.language)
    }) {
        return Err(Failure::new(
            "Semantic rename requires a configured JS/TS project.",
        ));
    }
    let hash = sha256_hex(&resolved.content);
    let reply = context.compiler.references(
        &ReferenceTarget {
            root: &context.files.root,
            path: &resolved.path,
            name: &resolved.symbol.qualified_name,
            start,
            end,
            hash: &hash,
            rename_to: Some(&new_name),
        },
        context.signal,
    )?;
    let reply = match reply {
        CompilerReply::Unavailable(reason) => {
            return Err(Failure::new(format!(
                "Semantic rename blocked: {reason}. Use inspected focused edits if appropriate."
            )));
        }
        CompilerReply::Ok(reply) => reply,
    };
    let footprint = reply.get("footprint").cloned().unwrap_or(Json::Null);
    if !footprint_is_current(&footprint, context.signal)? {
        return Err(Failure::new(
            "Semantic rename source or dependency changed. Read again and retry.",
        ));
    }
    let locations = reply
        .get("locations")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let reads = footprint
        .get("reads")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sources: Vec<(String, Arc<Vec<u8>>)> = Vec::new();
    for location in &locations {
        let path = context
            .files
            .normalize_path(location.get("path").and_then(Json::as_str).unwrap_or(""))?;
        if location.get("replacement").and_then(Json::as_str).is_none() {
            return Err(Failure::new("Invalid semantic rename plan."));
        }
        if !sources.iter().any(|(known, _)| *known == path) {
            sources.push((path.clone(), Arc::new(context.files.read(&path)?.content)));
        }
        let absolute = crate::pathx::resolve(&context.files.root, &path);
        let expected = reads
            .iter()
            .find(|read| read.get("path").and_then(Json::as_str) == Some(absolute.as_str()));
        let current = sources
            .iter()
            .find(|(known, _)| *known == path)
            .map(|(_, content)| sha256_hex(content));
        if expected
            .and_then(|read| read.get("hash"))
            .and_then(Json::as_str)
            != current.as_deref()
            || expected.is_none()
        {
            return Err(Failure::new("Semantic rename preimage changed."));
        }
    }
    let old_name = resolved.symbol.qualified_name.clone();
    let new_qualified = renamed(&old_name, &new_name);
    let receipt = rename_receipt(
        &reply,
        &locations,
        &sources,
        &resolved.path,
        &old_name,
        &new_name,
    );
    let mut plans: Vec<PlannedFile> = Vec::new();
    for location in &locations {
        let path = location
            .get("path")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();
        let known = sources
            .iter()
            .find(|(known, _)| *known == path)
            .map(|(_, content)| content.clone());
        let file = file_plan(&mut plans, &path, known, context.files)?;
        file.footprint = Some(footprint.clone());
        file.semantic_rename = Some(receipt.clone());
        if file.path == resolved.path {
            file.symbols.push(old_name.clone());
            file.symbols.push(new_qualified.clone());
        }
        let range = crate::coverage::intervals_from_json(Some(&Json::Arr(vec![
            location.get("range").cloned().unwrap_or(Json::Null),
        ])))[0];
        file.replacements.push(SourcedReplacement {
            start: range.0,
            end: range.1,
            replacement: location
                .get("replacement")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
            source: format!("semantic rename {target}"),
        });
    }
    for file in &mut plans {
        let touched = symbols_touched(
            &file.path,
            file.initial.as_deref().map(Vec::as_slice),
            &plain(&file.replacements),
        );
        file.symbols.extend(touched);
    }
    Ok(plans)
}

/// `qualifiedName.replace(/[^./]+$/u, newName)`.
fn renamed(qualified: &str, new_name: &str) -> String {
    let cut = qualified.rfind(['.', '/']).map_or(0, |index| index + 1);
    if cut == qualified.len() {
        qualified.to_string()
    } else {
        format!("{}{new_name}", &qualified[..cut])
    }
}

fn rename_receipt(
    reply: &Json,
    locations: &[Json],
    sources: &[(String, Arc<Vec<u8>>)],
    path: &str,
    qualified: &str,
    new_name: &str,
) -> Json {
    let mut paths: Vec<&String> = sources.iter().map(|(path, _)| path).collect();
    paths.sort_by(|left, right| crate::text::utf16_compare(left, right));
    let location_path = |location: &Json| {
        location
            .get("path")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string()
    };
    let edits_by_file: Vec<Json> = paths
        .iter()
        .map(|path| obj! { "path" => path.as_str(), "identifierEdits" => locations.iter().filter(|location| location_path(location) == **path).count() })
        .collect();
    let examples: Vec<Json> = locations
        .iter()
        .take(6)
        .map(|location| {
            let source = sources
                .iter()
                .find(|(known, _)| *known == location_path(location))
                .map(|(_, content)| content.clone())
                .unwrap_or_default();
            let range = crate::coverage::intervals_from_json(Some(&Json::Arr(vec![
                location.get("range").cloned().unwrap_or(Json::Null),
            ])))[0];
            let line_start = source[..range.0]
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |index| index + 1);
            let line_end = source[range.1..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(source.len(), |index| index + range.1);
            // Bound both sides around this identifier; never echo a giant source line.
            let left_text = String::from_utf8_lossy(&source[line_start..range.0]).into_owned();
            let left_units: Vec<u16> = left_text.encode_utf16().collect();
            let left =
                String::from_utf16_lossy(&left_units[left_units.len().saturating_sub(100)..]);
            let right_text = String::from_utf8_lossy(&source[range.1..line_end]).into_owned();
            let right = utf16_prefix(&right_text, 100).to_string();
            let identifier = String::from_utf8_lossy(&source[range.0..range.1]).into_owned();
            let replacement = location
                .get("replacement")
                .and_then(Json::as_str)
                .unwrap_or("");
            obj! {
                "path" => location_path(location),
                "lines" => location.get("lines").cloned().unwrap_or(Json::Null),
                "before" => format!("{left}{identifier}{right}"),
                "after" => format!("{left}{replacement}{right}"),
            }
        })
        .collect();
    let project = reply.get("project").cloned().unwrap_or(Json::Null);
    obj! {
        "config" => project.get("config").cloned().unwrap_or(Json::Null),
        "compilerVersion" => project.get("compilerVersion").cloned().unwrap_or(Json::Null),
        "identifierEdits" => locations.len(),
        "from" => format!("{path}#{qualified}"),
        "to" => format!("{path}#{}", renamed(qualified, new_name)),
        "editsByFile" => Json::Arr(edits_by_file),
        "examplesTruncated" => locations.len() > examples.len(),
        "examples" => Json::Arr(Vec::new()),
    }
    .with("examples", Json::Arr(examples.clone()))
    .reordered(&[
        "config",
        "compilerVersion",
        "identifierEdits",
        "from",
        "to",
        "editsByFile",
        "examples",
        "examplesTruncated",
    ])
}

fn assert_compatible_mutations(file: &PlannedFile) -> Outcome<()> {
    if file.mutation.is_some() && file.replacements.len() > 1 {
        return Err(Failure::new(format!(
            "File creation or deletion cannot overlap another edit in {}.",
            file.path
        )));
    }
    let mut ordered: Vec<&SourcedReplacement> = file.replacements.iter().collect();
    ordered.sort_by(|left, right| left.start.cmp(&right.start).then(right.end.cmp(&left.end)));
    for pair in ordered.windows(2) {
        if overlap(pair[0], pair[1]) {
            return Err(Failure::new(format!(
                "Edit operations overlap in {}: {} conflicts with {}. Replace their common parent once, or split the edits and re-read after the first commit.",
                file.path, pair[0].source, pair[1].source
            )));
        }
    }
    Ok(())
}

fn overlap(left: &SourcedReplacement, right: &SourcedReplacement) -> bool {
    let insertion = |replacement: &SourcedReplacement| replacement.start == replacement.end;
    let inside = |offset: usize, replacement: &SourcedReplacement| {
        offset > replacement.start && offset < replacement.end
    };
    match (insertion(left), insertion(right)) {
        (true, true) => left.start == right.start,
        (true, false) => inside(left.start, right),
        (false, true) => inside(right.start, left),
        (false, false) => left.start < right.end && right.start < left.end,
    }
}

fn apply_plan(plan: &PlannedFile) -> Option<Vec<u8>> {
    if plan.mutation == Some(FileMutation::Delete) {
        return None;
    }
    let mut content = plan
        .initial
        .as_ref()
        .map(|initial| initial.to_vec())
        .unwrap_or_default();
    let mut descending: Vec<&SourcedReplacement> = plan.replacements.iter().collect();
    descending.sort_by(|left, right| right.start.cmp(&left.start).then(right.end.cmp(&left.end)));
    for replacement in descending {
        content.splice(
            replacement.start..replacement.end,
            replacement.replacement.bytes(),
        );
    }
    Some(content)
}

fn finalize(plans: Vec<PlannedFile>, context: &mut EditContext<'_>) -> Outcome<Vec<FinalFile>> {
    plans
        .into_iter()
        .map(|plan| {
            let content = apply_plan(&plan);
            let (parse_status, diagnostics) = final_parse_status(
                context,
                &plan.path,
                plan.initial.as_deref().map(Vec::as_slice),
                content.as_deref(),
            )?;
            Ok(FinalFile {
                plan,
                content,
                parse_status,
                diagnostics,
            })
        })
        .collect()
}

fn validate_final(
    context: &EditContext<'_>,
    path: &str,
    content: &[u8],
) -> Outcome<crate::validation::ContentValidation> {
    let external = if path.ends_with(".prisma") {
        "unsupported"
    } else {
        "enabled"
    };
    validate_content(
        context.compiler,
        &context.files.root,
        path,
        Some(content),
        external,
        context.signal,
    )
}

fn final_parse_status(
    context: &EditContext<'_>,
    path: &str,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
) -> Outcome<(String, Vec<String>)> {
    let Some(after) = after else {
        return Ok(("unsupported".into(), Vec::new()));
    };
    let validation = validate_final(context, path, after)?;
    match validation.status.as_str() {
        "passed" => Ok(("passed".into(), Vec::new())),
        "unsupported" => {
            let unavailable =
                capability_for_path(path).is_some_and(|capability| !capability.loaded);
            Ok((
                if unavailable {
                    "unavailable"
                } else {
                    "unsupported"
                }
                .into(),
                validation.diagnostics,
            ))
        }
        _ => {
            let status = match before {
                Some(before) if validation.status == "failed" => {
                    let previous = validate_final(context, path, before)?;
                    if previous.status != "failed" {
                        "failed"
                    } else {
                        let (previous_parse, current_parse) =
                            (parse_code(path, before), parse_code(path, after));
                        let not_worse = current_parse.error_count <= previous_parse.error_count
                            && validation.diagnostics.len() <= previous.diagnostics.len();
                        if previous_parse.supported && not_worse {
                            "degraded_preexisting_errors"
                        } else {
                            "failed"
                        }
                    }
                }
                _ => "failed",
            };
            Ok((status.into(), validation.diagnostics))
        }
    }
}

fn invalid_parse_result(file: &FinalFile) -> Json {
    let diagnostic = file
        .diagnostics
        .first()
        .map(|diagnostic| format!(" {diagnostic}"))
        .unwrap_or_default();
    obj! {
        "status" => "blocked",
        "category" => "code",
        "message" => format!("Final parse failed for {}; no files were written.{diagnostic}", file.plan.path),
        "recovery" => "Correct the final syntax and submit one new atomic batch.",
    }
}

fn patch_failure_recovery(message: &str) -> Option<&'static str> {
    let lower = message.to_lowercase();
    if lower.contains("context is ambiguous") {
        return Some(
            "Do not resend the same patch. Read the affected outline and target its symbol or selector alias, or add one short unique context line.",
        );
    }
    if lower.contains("context does not match") {
        return Some(
            "Read only the affected symbol or short range, then submit a focused patch against the current text.",
        );
    }
    if lower.contains("too many files") || lower.contains("too many operations") {
        return Some(
            "Split the change into smaller atomic batches without repeating completed files.",
        );
    }
    None
}

fn edit_failure(failure: &Failure) -> Json {
    let id = diagnostic_id();
    if let Some(recovery) = &failure.recovery {
        return obj! { "status" => "blocked", "category" => "input", "message" => failure.message.as_str(), "recovery" => recovery.as_str(), "diagnosticId" => id };
    }
    let recovery = if failure.candidates.is_empty() {
        patch_failure_recovery(&failure.message).map(str::to_string)
    } else {
        Some(Json::Arr(failure.candidates.clone()).stringify())
    };
    obj! { "status" => "blocked", "category" => "input", "message" => failure.message.as_str() }
        .with_opt("recovery", recovery)
        .with("diagnosticId", id)
}

fn commit_failure(failure: &Failure) -> Json {
    if failure.conflict {
        return obj! { "status" => "blocked", "category" => "input", "message" => failure.message.as_str(), "diagnosticId" => diagnostic_id() };
    }
    obj! { "status" => "failed", "category" => "harness", "recovery" => "recovery_required", "message" => failure.message.as_str(), "diagnosticId" => diagnostic_id() }
}

fn parse_summary(files: &[FinalFile]) -> Json {
    let priority = [
        "failed",
        "unavailable",
        "degraded_preexisting_errors",
        "unsupported",
        "passed",
    ];
    let status = priority
        .iter()
        .find(|status| files.iter().any(|file| file.parse_status == **status))
        .copied()
        .unwrap_or("unsupported");
    obj! {
        "status" => status,
        "files" => Json::Arr(files.iter().map(|file| {
            let entry = obj! { "path" => file.plan.path.as_str(), "status" => file.parse_status.as_str() };
            if file.diagnostics.is_empty() { entry } else { entry.with("diagnostics", Json::Arr(file.diagnostics.iter().map(Json::from).collect())) }
        }).collect()),
    }
}

fn body_edit_context(files: &[FinalFile]) -> Json {
    let headers: Vec<Json> = files
        .iter()
        .flat_map(|file| {
            file.plan.body_headers.iter().map(|header| {
                obj! {
                    "path" => file.plan.path.as_str(),
                    "target" => header.target.as_str(),
                    "qualifiedName" => header.qualified_name.as_str(),
                    "header" => header.header.as_str(),
                    "truncated" => header.truncated,
                }
            })
        })
        .collect();
    if headers.is_empty() {
        return Json::obj();
    }
    obj! {
        "bodyEditContext" => obj! {
            "headers" => Json::Arr(headers.iter().take(4).cloned().collect()),
            "omitted" => headers.len().saturating_sub(4),
            "scope" => "headers_before_body_edits",
            "instruction" => "replace_body retains these parameters and return types and does not add imports. Other explicit operations in this batch may change them. Use the shown parameter names; to change a header or imports, read the complete declaration/file and use replace or a file patch. This receipt grants no additional read coverage or type validation.",
        },
    }
}

fn source_lines(value: &str) -> Vec<&str> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = value.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn file_change(file: &FinalFile) -> Json {
    let before_text = file
        .plan
        .initial
        .as_ref()
        .map(|initial| String::from_utf8_lossy(initial).into_owned())
        .unwrap_or_default();
    let after_text = file
        .content
        .as_ref()
        .map(|content| String::from_utf8_lossy(content).into_owned())
        .unwrap_or_default();
    let (before, after) = (source_lines(&before_text), source_lines(&after_text));
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in &after {
        *counts.entry(line).or_default() += 1;
    }
    let mut common = 0;
    for line in &before {
        if let Some(available) = counts.get_mut(line).filter(|available| **available > 0) {
            *available -= 1;
            common += 1;
        }
    }
    let mut symbols: Vec<String> = Vec::new();
    for symbol in &file.plan.symbols {
        if !symbols.contains(symbol) {
            symbols.push(symbol.clone());
        }
    }
    let change = obj! { "path" => file.plan.path.as_str(), "additions" => after.len() - common, "deletions" => before.len() - common };
    if symbols.is_empty() {
        change
    } else {
        change.with(
            "symbols",
            Json::Arr(symbols.iter().map(Json::from).collect()),
        )
    }
}

/// Aliases of the touched symbols, kept or created, after a commit.
fn refresh_aliases(
    paths: &[String],
    touched: &[String],
    context: &mut EditContext<'_>,
) -> Outcome<Vec<Json>> {
    let existing: Vec<Alias> = context
        .aliases
        .entries()
        .iter()
        .filter_map(Alias::from_json)
        .collect();
    let mut output: Vec<Json> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for path in paths {
        let Some(file) = optional_file(context.files, path)? else {
            continue;
        };
        let content = file.content;
        let parsed = parse_code(path, &content);
        for symbol in &parsed.symbols {
            let matching: Vec<&Alias> = existing
                .iter()
                .filter(|entry| {
                    matches!(entry, Alias::Symbol { path: known, qualified_name, symbol_kind, .. }
                        if known == path && *qualified_name == symbol.qualified_name && symbol_kind == symbol.kind)
                })
                .collect();
            let is_touched = touched.contains(&symbol.qualified_name);
            if matching.is_empty() && !is_touched {
                continue;
            }
            let previously_complete = matching.iter().any(|entry| match entry {
                Alias::Symbol {
                    alias, start, end, ..
                } => context
                    .aliases
                    .assert_observed(Some(alias), (0, end - start))
                    .is_ok(),
                _ => false,
            });
            let alias = context.aliases.register_symbol(path, &content, symbol);
            if previously_complete && is_touched {
                context.aliases.observe(path, &content, &[symbol.range]);
            }
            if is_touched && !seen.contains(&alias) {
                seen.push(alias.clone());
                output.push(obj! { "alias" => alias, "path" => path.as_str(), "qualifiedName" => symbol.qualified_name.as_str() });
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_the_last_name_segment() {
        assert_eq!(renamed("Box.grow", "expand"), "Box.expand");
        assert_eq!(renamed("calculate", "compute"), "compute");
    }
}
