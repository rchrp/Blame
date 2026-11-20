//! One session's harness on one workspace: the read side of
//! `light-workspace.ts` (search_code, read_code), with seams for editing,
//! run_task and completion, which later parts port.

use crate::aliases::{Alias, AliasRegistry, ResolvedSymbol};
use crate::attention::LightAttention;
use crate::compiler::{CompilerPort, CompilerReply, DeclarationTarget};
use crate::coverage::{Interval, ReadCoverage, Registered};
use crate::failure::{Failure, Outcome, Signal};
use crate::files::{WorkspaceFiles, WorkspaceSnapshot, assert_mutable_workspace_path};
use crate::fold::{
    FOLD_VIEW_CHARACTERS, FoldPlan, fold_file_minimum_characters, line_aligned_window,
    outline_minimum_characters, plan_fold, render_fold,
};
use crate::identity::sha256_hex;
use crate::journal::{ObservationAudit, SessionJournal};
use crate::json::Json;
use crate::languages::capability_for_path;
use crate::lock::WorkspaceLock;
use crate::navigation::{
    ReadInput, edit_target_symbols, enclosing_symbol, qualified_target, requested_line_range,
    routed_view,
};
use crate::obj;
use crate::pathx;
use crate::read_results::*;
use crate::search::CodeSearch;
use crate::search_results::SearchInput;
use crate::syntax::{ParseResult, parse_code, symbol_edit_range};
use crate::text::{js_trim, utf16_len};
use regex::Regex;
use std::sync::{Arc, LazyLock};

const MAXIMUM_RAW_CHARACTERS: usize = 64_000;
const MAXIMUM_DIRECTORY_ENTRIES: usize = 64;
const MAXIMUM_REMEMBERED_MARKERS: usize = 5_000;
const TWO_MIB: usize = 2 * 1024 * 1024;

/// An insertion-ordered set that forgets its oldest keys beyond a limit.
struct Remembered {
    keys: Vec<String>,
    limit: usize,
}

impl Remembered {
    fn new(limit: usize) -> Remembered {
        Remembered {
            keys: Vec::new(),
            limit,
        }
    }
    fn contains(&self, key: &str) -> bool {
        self.keys.iter().any(|known| known == key)
    }
    fn remember(&mut self, key: String) {
        self.keys.retain(|known| *known != key);
        self.keys.push(key);
        if self.keys.len() > self.limit {
            let excess = self.keys.len() - self.limit;
            self.keys.drain(..excess);
        }
    }
}

struct PlannedFold {
    parsed: Arc<ParseResult>,
    plan: FoldPlan,
    window: Interval,
}

pub struct Workspace {
    files: WorkspaceFiles,
    task_contract: Json,
    compiler: Arc<dyn CompilerPort>,
    aliases: AliasRegistry,
    attention: LightAttention,
    coverage: ReadCoverage,
    journal: SessionJournal,
    /// Files each consumer last saw folded, by content: a raw re-read then returns only what the fold hid.
    folded_views: Remembered,
    /// Marker lines shown in folded views, refused when an edit copies one into source.
    shown_markers: Remembered,
    /// Files whose cross-file links each consumer already got, by content.
    linked_reads: Remembered,
    /// Identifiers of the task and of the session's searches: the links worth naming first.
    focus: Vec<String>,
    latest_snapshot: Option<WorkspaceSnapshot>,
    ready: bool,
}

impl Workspace {
    pub fn new(
        root: &str,
        session_id: &str,
        task_contract: Json,
        compiler: Arc<dyn CompilerPort>,
    ) -> Workspace {
        let files = WorkspaceFiles::new(root);
        let journal = SessionJournal::new(&files.root, session_id);
        Workspace {
            files,
            task_contract,
            compiler,
            aliases: AliasRegistry::default(),
            attention: LightAttention::default(),
            coverage: ReadCoverage::default(),
            journal,
            folded_views: Remembered::new(2_000),
            shown_markers: Remembered::new(MAXIMUM_REMEMBERED_MARKERS),
            linked_reads: Remembered::new(2_000),
            focus: Vec::new(),
            latest_snapshot: None,
            ready: false,
        }
    }

    pub fn root(&self) -> &str {
        &self.files.root
    }

    /// Replays the journal once, under the workspace lock.
    fn ensure_ready(&mut self) -> Outcome<()> {
        if self.ready {
            return Ok(());
        }
        {
            let _lock = WorkspaceLock::acquire(&self.files.root)?;
            self.journal.hydrate();
        }
        self.aliases.hydrate(self.journal.current_aliases());
        self.coverage.hydrate(self.journal.current_coverage());
        self.attention.hydrate(self.journal.current_attention());
        for entry in self.coverage.entries().to_vec() {
            self.aliases
                .remember_observation(&entry.path, &entry.hash, &entry.intervals);
        }
        self.ready = true;
        let objective = self
            .task_contract
            .get("objective")
            .and_then(Json::as_str)
            .map(str::to_string);
        if let Some(objective) = objective.filter(|objective| !objective.is_empty()) {
            self.add_focus(&objective);
            self.journal.ingest_user_request("initial", &objective)?;
        }
        Ok(())
    }

    pub fn search_code(&mut self, input: &Json, signal: &Signal) -> Outcome<Json> {
        match self.search_code_inner(input, signal) {
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(input_blocked(&failure)),
            Ok(result) => Ok(result),
        }
    }

    fn search_code_inner(&mut self, input: &Json, signal: &Signal) -> Outcome<Json> {
        self.ensure_ready()?;
        let request = SearchInput { raw: input.clone() };
        let result = {
            let _lock = WorkspaceLock::acquire(&self.files.root)?;
            let mut search = CodeSearch {
                files: &self.files,
                aliases: &mut self.aliases,
                compiler: &*self.compiler,
                signal,
                revision: String::new(),
            };
            search.search(&request)?
        };
        self.persist_aliases()?;
        self.record_observation_audit("search_code", request.mode().unwrap_or("auto"), &result)?;
        if is_ok(&result) {
            let hits = search_hits(result.get("data").unwrap_or(&Json::Null));
            self.point_at(hits)?;
        }
        self.add_focus(request.query());
        Ok(result)
    }

    pub fn read_code(
        &mut self,
        input: &ReadInput,
        context: &Json,
        signal: &Signal,
    ) -> Outcome<Json> {
        let outcome = self.ensure_ready().and_then(|()| {
            let result = {
                let _lock = WorkspaceLock::acquire(&self.files.root)?;
                self.read_current_workspace(input, context, signal)?
            };
            self.record_observation_audit(
                "read_code",
                input.view.as_deref().unwrap_or("auto"),
                &result,
            )?;
            Ok(result)
        });
        match outcome {
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(input_blocked(&failure)),
            Ok(result) => Ok(result),
        }
    }

    fn read_current_workspace(
        &mut self,
        input: &ReadInput,
        context: &Json,
        signal: &Signal,
    ) -> Outcome<Json> {
        signal.check()?;
        if input.view.as_deref() == Some("declaration") {
            return self.read_dependency_declaration(input);
        }
        if input.offset.is_some() {
            return Err(Failure::new(
                "offset is only supported for declaration continuation.",
            ));
        }
        if let Some(image) = self.read_isolated_environment_image(&input.target, context, signal)? {
            return Ok(image);
        }
        if let Some(special) = self.special_read_result(&input.target) {
            return special;
        }
        let snapshot = self.files.snapshot(signal)?;
        let revision = snapshot.revision.source_revision_id.clone();
        let literal_path =
            self.aliases.get(&input.target).is_none() && !qualified_target(&input.target);
        self.latest_snapshot = Some(snapshot);
        let read = (|| {
            if let Some(directory) = self.directory_read_result(input, context)? {
                return Ok(directory);
            }
            self.read_workspace_target(input, &revision, context, signal)
        })();
        match read {
            Err(failure) if literal_path && failure.is_missing() => {
                self.missing_path_recovery(input, failure, signal)
            }
            other => other,
        }
    }

    /// Discovery only: no source contents, aliases, observation coverage or writes.
    fn missing_path_recovery(
        &self,
        input: &ReadInput,
        failure: Failure,
        signal: &Signal,
    ) -> Outcome<Json> {
        signal.check()?;
        let requested = self.files.normalize_path(&input.target)?;
        assert_mutable_workspace_path(&requested)?;
        match self.files.path_profile(&requested) {
            Ok(_) => return Err(failure), // ENOENT may instead come from a journal/related read.
            Err(error) if error.is_missing() => {}
            Err(_) => return Err(failure),
        }
        let snapshot = self
            .latest_snapshot
            .as_ref()
            .expect("snapshot taken before the read");
        let deleted: Vec<&str> = snapshot
            .changes
            .iter()
            .filter(|change| change.status == crate::files::ChangeStatus::Deleted)
            .map(|change| change.path.as_str())
            .collect();
        let mut matches: Vec<&String> = snapshot
            .files
            .iter()
            .filter(|path| {
                **path != requested
                    && !deleted.contains(&path.as_str())
                    && pathx::basename(path) == pathx::basename(&requested)
            })
            .collect();
        matches.sort_by(|left, right| crate::text::utf16_compare(left, right));
        // Generic basenames (for example index.ts) can yield hundreds of
        // unrelated files: keep the original failure instead.
        if matches.len() > 32 {
            return Err(failure);
        }
        let mut candidates = Vec::new();
        for path in matches {
            signal.check()?;
            if assert_mutable_workspace_path(path).is_err() || self.files.file_size(path).is_err() {
                continue;
            }
            // A leading ./ prevents a filename such as s1 from resolving as an alias.
            candidates.push(obj! { "path" => path.as_str(), "nextRead" => obj! { "target" => format!("./{path}") } });
            if candidates.len() > 5 {
                return Err(failure);
            }
        }
        if candidates.is_empty() {
            return Err(failure);
        }
        let mut blocked = input_blocked(&failure);
        blocked.set(
            "recovery",
            obj! {
                "kind" => "missing_workspace_path",
                "requestedPath" => requested.as_str(),
                "match" => "exact_basename",
                "scope" => "indexed_workspace_files",
                "candidates" => Json::Arr(candidates),
                "guidance" => "The requested path does not exist. These indexed files share its basename; they are candidates, not resolved targets. Choose and read the intended file explicitly. This recovery returns paths only and grants no edit coverage.",
            }
            .stringify(),
        );
        Ok(blocked)
    }

    fn special_read_result(&self, target: &str) -> Option<Outcome<Json>> {
        match target {
            // The validation report and its repair plan belong to the
            // run_task and completion parts, not ported yet.
            "@checks" => Some(Err(Failure::new(
                "@checks is not available in this harness yet: check observations are recorded by run_task.",
            ))),
            "@capabilities" => Some(Ok(capabilities_result())),
            "@changes" => Some(Ok(
                obj! { "status" => "ok", "data" => obj! { "changes" => Json::Arr(self.journal.current_changes()) } },
            )),
            _ => None,
        }
    }

    fn directory_read_result(
        &mut self,
        input: &ReadInput,
        context: &Json,
    ) -> Outcome<Option<Json>> {
        if self.aliases.get(&input.target).is_some() || qualified_target(&input.target) {
            return Ok(None);
        }
        let path = self.files.normalize_path(&input.target)?;
        assert_mutable_workspace_path(&path)?;
        if !self.files.path_profile(&path)?.directory {
            return Ok(None);
        }
        let files = self
            .latest_snapshot
            .as_ref()
            .map(|snapshot| snapshot.files.clone())
            .unwrap_or_default();
        let entries = directory_entries(&path, &files);
        let listing = directory_entries_json(&entries);
        let content = listing.stringify().into_bytes();
        let coverage = self.register_coverage(
            &format!("{path}/"),
            &content,
            &[(0, content.len())],
            context,
        )?;
        if coverage.covered {
            return Ok(Some(covered_directory_result(&path, &coverage.receipt)));
        }
        let shown = Json::Arr(
            listing
                .as_array()
                .expect("entries")
                .iter()
                .take(MAXIMUM_DIRECTORY_ENTRIES)
                .cloned()
                .collect(),
        );
        Ok(Some(obj! {
            "status" => "ok",
            "receipt" => coverage.receipt.as_str(),
            "data" => obj! {
                "candidateCount" => entries.len(),
                "entries" => shown,
                "path" => path.as_str(),
                "truncated" => entries.len() > MAXIMUM_DIRECTORY_ENTRIES,
                "view" => "directory",
            },
        }))
    }

    fn read_workspace_target(
        &mut self,
        input: &ReadInput,
        revision: &str,
        context: &Json,
        signal: &Signal,
    ) -> Outcome<Json> {
        let result = match self.aliases.get(&input.target).cloned() {
            Some(Alias::Path { path, .. }) => {
                let aliased = ReadInput {
                    target: path,
                    ..input.clone()
                };
                self.read_path(&aliased, revision, context, signal)?
            }
            Some(range @ Alias::Range { .. }) => {
                self.read_range_alias(&range, input, revision, context)?
            }
            Some(Alias::Symbol { .. }) => {
                self.read_symbol(&input.target, revision, context, input)?
            }
            None if qualified_target(&input.target) => {
                self.read_symbol(&input.target, revision, context, input)?
            }
            None => self.read_path(input, revision, context, signal)?,
        };
        self.persist_aliases()?;
        Ok(result)
    }

    fn read_path(
        &mut self,
        input: &ReadInput,
        revision: &str,
        context: &Json,
        signal: &Signal,
    ) -> Outcome<Json> {
        let path = self.files.normalize_path(&input.target)?;
        assert_mutable_workspace_path(&path)?;
        if let Some(image) = read_workspace_image(&self.files, &path, context, signal)? {
            return Ok(image);
        }
        let content = Arc::new(self.files.read(&path)?.content);
        readable_source(&content)?;
        let view = routed_view(input);
        if view == "signature" {
            return Err(Failure::new(
                "Signature view requires a symbol alias or path#qualifiedName. Read the file outline to choose a declaration.",
            ));
        }
        if view == "range" {
            return self.read_line_range(&path, &content, input, revision, context);
        }
        let whole = self.read_whole_path(input, &view, &path, &content, revision, context)?;
        self.with_links(&path, &content, context, whole)
    }

    fn read_whole_path(
        &mut self,
        input: &ReadInput,
        view: &str,
        path: &str,
        content: &Arc<Vec<u8>>,
        revision: &str,
        context: &Json,
    ) -> Outcome<Json> {
        if view == "outline" {
            return self.read_outline_path(path, content, revision, context, input);
        }
        if view == "auto" {
            // A file larger than a folded view is always folded, down to one line per declaration if need be.
            let always = utf16_len(&String::from_utf8_lossy(content)) > FOLD_VIEW_CHARACTERS;
            if let Some(folded) = self.planned_fold(
                path,
                content,
                (0, content.len()),
                fold_file_minimum_characters() as i64,
                always,
            ) {
                return self.fold_result(path, content, folded, revision, context);
            }
        }
        self.raw(
            path,
            content,
            revision,
            context,
            if view == "symbol" {
                Some("symbol_target_missing")
            } else {
                None
            },
        )
    }

    /// On a file's first whole or folded read, one line naming who uses its
    /// exports and which tests import it, from the compiler tier's import index.
    fn with_links(
        &mut self,
        path: &str,
        content: &[u8],
        context: &Json,
        mut result: Json,
    ) -> Outcome<Json> {
        if !is_ok(&result) {
            return Ok(result);
        }
        let data = result.get("data").cloned().unwrap_or(Json::Null);
        if data.get("view").and_then(Json::as_str) != Some("folded")
            && data.get("complete").and_then(Json::as_bool) != Some(true)
        {
            return Ok(result);
        }
        let key = fold_key(path, content, context);
        if self.linked_reads.contains(&key) {
            return Ok(result);
        }
        self.linked_reads.remember(key);
        let Some(snapshot) = self.latest_snapshot.as_ref() else {
            return Ok(result);
        };
        if let Some(links) =
            self.compiler
                .brief_links(&self.files.root, path, content, &self.focus, snapshot)
            && let Some(data) = result.get_mut("data")
        {
            data.set("links", links);
        }
        Ok(result)
    }

    fn read_outline_path(
        &mut self,
        path: &str,
        content: &Arc<Vec<u8>>,
        revision: &str,
        context: &Json,
        input: &ReadInput,
    ) -> Outcome<Json> {
        if !parse_code(path, content).supported {
            return self.raw(
                path,
                content,
                revision,
                context,
                Some("symbol_view_unavailable"),
            );
        }
        let ranges: Vec<Interval> = input
            .ranges
            .iter()
            .map(|(start, end)| line_byte_range(content, *start, *end))
            .collect::<Outcome<_>>()?;
        let window = if ranges.is_empty() {
            (0, content.len())
        } else {
            (
                ranges.iter().map(|range| range.0).min().unwrap_or(0),
                ranges.iter().map(|range| range.1).max().unwrap_or(0),
            )
        };
        if let Some(folded) = self.planned_fold(
            path,
            content,
            window,
            outline_minimum_characters() as i64,
            false,
        ) {
            return self.fold_result(path, content, folded, revision, context);
        }
        // Folding would save less than the call that unfolds it.
        if ranges.is_empty() {
            self.raw(
                path,
                content,
                revision,
                context,
                Some("outline_not_smaller"),
            )
        } else {
            self.read_line_range(path, content, input, revision, context)
        }
    }

    /// A fold of `window` when it removes at least `minimum` characters.
    fn planned_fold(
        &self,
        path: &str,
        content: &[u8],
        window: Interval,
        minimum: i64,
        always: bool,
    ) -> Option<PlannedFold> {
        if content.len() > TWO_MIB {
            return None;
        }
        let parsed = parse_code(path, content);
        if !parsed.supported {
            return None;
        }
        let aligned = line_aligned_window(content, window);
        let plan = plan_fold(content, &parsed, aligned, &self.attention.for_file(path));
        (always || (!plan.markers.is_empty() && plan.removed >= minimum)).then_some(PlannedFold {
            parsed,
            plan,
            window: aligned,
        })
    }

    fn fold_result(
        &mut self,
        path: &str,
        content: &Arc<Vec<u8>>,
        folded: PlannedFold,
        revision: &str,
        context: &Json,
    ) -> Outcome<Json> {
        let PlannedFold {
            parsed,
            plan,
            window,
        } = folded;
        let aliases = &mut self.aliases;
        let view = render_fold(content, &parsed, window, &plan, &mut |symbol| {
            Some(aliases.register_symbol(path, content, symbol))
        });
        for (_, text) in &view.markers {
            self.shown_markers.remember(js_trim(text).to_string());
        }
        let coverage = self.register_coverage(path, content, &view.shown, context)?;
        self.folded_views.remember(fold_key(path, content, context));
        let whole = window.0 == 0 && window.1 == content.len();
        let edit_targets = if whole {
            self.register_edit_targets(path, content, revision, None)
        } else {
            Vec::new()
        };
        Ok(folded_content_result(
            path,
            content,
            window,
            &view,
            &plan,
            &coverage.receipt,
            &edit_targets,
        ))
    }

    /// A whole-file read right after a folded view of the same content
    /// returns only what the fold hid: the rest is already in context.
    fn folded_delta(
        &mut self,
        path: &str,
        content: &[u8],
        context: &Json,
    ) -> Outcome<Option<Json>> {
        if !self
            .folded_views
            .contains(&fold_key(path, content, context))
        {
            return Ok(None);
        }
        let (consumer, generation) = coverage_scope(context);
        let uncovered = self.coverage.uncovered(
            (&consumer, &generation),
            &sha256_hex(content),
            path,
            &[(0, content.len())],
        );
        if uncovered.is_empty() {
            let coverage = self.register_coverage(path, content, &[], context)?;
            return Ok(Some(obj! {
                "status" => "ok",
                "receipt" => coverage.receipt.as_str(),
                "data" => obj! {
                    "path" => path,
                    "view" => "raw",
                    "status" => "already_in_context",
                    "note" => "Your folded view and later reads of this file already hold every line of its current content.",
                },
            }));
        }
        let mut intervals = Vec::new();
        let mut budget = MAXIMUM_RAW_CHARACTERS as i64;
        let mut truncated = false;
        for (start, end) in uncovered {
            let mut stop = end.min((start as i64 + budget.max(0)) as usize);
            while stop > start && stop < content.len() && (content[stop] & 0xc0) == 0x80 {
                stop -= 1;
            }
            if stop > start {
                intervals.push((start, stop));
            }
            budget -= (stop - start) as i64;
            if stop < end {
                truncated = true;
                break;
            }
        }
        let mut result = self.covered_content(
            path,
            content,
            &intervals,
            context,
            "raw",
            Some("folded_view_delta"),
            truncated,
            &[],
        )?;
        if let Some(data) = result.get_mut("data") {
            data.set("delta", "Only the lines your folded view of this file hid; the other lines are in that view, unchanged.");
        }
        Ok(Some(result))
    }

    fn read_line_range(
        &mut self,
        path: &str,
        content: &[u8],
        input: &ReadInput,
        revision: &str,
        context: &Json,
    ) -> Outcome<Json> {
        if input.ranges.is_empty() {
            return Err(Failure::new("range is required for the range view."));
        }
        let ranges: Vec<Interval> = input
            .ranges
            .iter()
            .map(|(start, end)| line_byte_range(content, *start, *end))
            .collect::<Outcome<_>>()?;
        let intervals = merged_intervals(ranges);
        let edit_targets = self.register_edit_targets(path, content, revision, Some(&intervals));
        self.covered_content(
            path,
            content,
            &intervals,
            context,
            "range",
            None,
            false,
            &edit_targets,
        )
    }

    fn read_symbol(
        &mut self,
        target: &str,
        revision: &str,
        context: &Json,
        input: &ReadInput,
    ) -> Outcome<Json> {
        let resolved = self.resolve_read_symbol(target)?;
        if requested_line_range(input) {
            return self.read_line_range(
                &resolved.path,
                &resolved.content,
                input,
                revision,
                context,
            );
        }
        match input.view.as_deref() {
            Some("outline") => return self.symbol_outline(&resolved, revision, context),
            Some("signature") => return self.read_signature(&resolved, context),
            _ => {}
        }
        let (start, end) = resolved.symbol.range;
        let content = resolved.content.clone();
        if end - start > MAXIMUM_RAW_CHARACTERS {
            if let Some(folded) =
                self.planned_fold(&resolved.path, &content, (start, end), 0, false)
            {
                return self.fold_result(&resolved.path, &content, folded, revision, context);
            }
            let mut bounded = start + MAXIMUM_RAW_CHARACTERS;
            while bounded > start && (content[bounded] & 0xc0) == 0x80 {
                bounded -= 1;
            }
            let target = (
                resolved.alias.clone().unwrap_or_default(),
                resolved.symbol.qualified_name.clone(),
            );
            return self.covered_content(
                &resolved.path,
                &content,
                &[(start, bounded)],
                context,
                "range",
                Some("symbol_exceeds_inline_budget"),
                true,
                &[target],
            );
        }
        let signature = symbol_edit_range(&resolved.symbol, "signature");
        let body_range = symbol_edit_range(&resolved.symbol, "body");
        let body = if capability_for_path(&resolved.path)
            .is_some_and(|capability| capability.language == "python")
        {
            python_body_range(&content, body_range)
        } else {
            body_range
        };
        let imports = short_import_block(&String::from_utf8_lossy(&content));
        let mut observed = vec![resolved.symbol.range];
        if let Some((_, range)) = &imports {
            observed.push(*range);
        }
        let coverage = self.register_coverage(&resolved.path, &content, &observed, context)?;
        let mut deltas = vec![signature, body];
        deltas.extend(coverage.uncovered.iter().copied());
        let mut data = obj! {
            "path" => resolved.path.as_str(),
            "view" => "symbol",
        }
        .with_opt("alias", resolved.alias.as_deref())
        .with_opt("editTarget", resolved.alias.as_deref())
        .with("kind", resolved.symbol.kind)
        .with("qualifiedName", resolved.symbol.qualified_name.as_str())
        .with("lines", Json::from(resolved.symbol.line_range));
        let text = |range: Interval| {
            String::from_utf8_lossy(&content[range.0..range.1.max(range.0)]).into_owned()
        };
        if has_delta(signature, &deltas) {
            data.set("signature", text((resolved.symbol.range.0, body.0)));
        }
        if has_delta(body, &deltas) {
            data.set("body", text((body.0, resolved.symbol.range.1)));
        }
        if let Some((block, range)) = imports
            && has_delta(range, &deltas)
        {
            data.set("imports", block);
        }
        Ok(obj! { "status" => "ok", "receipt" => coverage.receipt.as_str(), "data" => data })
    }

    fn resolve_read_symbol(&mut self, target: &str) -> Outcome<ResolvedSymbol> {
        let mut resolved = self.aliases.resolve_symbol(target, &self.files)?;
        let alias =
            self.aliases
                .register_symbol(&resolved.path, &resolved.content, &resolved.symbol);
        resolved.alias = Some(alias);
        Ok(resolved)
    }

    fn read_signature(&mut self, resolved: &ResolvedSymbol, context: &Json) -> Outcome<Json> {
        let (start, end) = symbol_edit_range(&resolved.symbol, "signature");
        let content = &resolved.content;
        let mut bounded = end.min(start + 4_096);
        while bounded > start && bounded < content.len() && (content[bounded] & 0xc0) == 0x80 {
            bounded -= 1;
        }
        let coverage =
            self.register_coverage(&resolved.path, content, &[(start, bounded)], context)?;
        let data = obj! { "path" => resolved.path.as_str() }
            .with_opt("alias", resolved.alias.as_deref())
            .with("view", "signature")
            .with("qualifiedName", resolved.symbol.qualified_name.as_str())
            .with("signature", String::from_utf8_lossy(&content[start..bounded]).into_owned())
            .with("truncated", bounded < end)
            .with("bodyOmitted", bounded < resolved.symbol.range.1)
            .with("guidance", "Only these header bytes were read. Use the symbol view for implementation, type members or a complete declaration before editing or rename.");
        Ok(obj! { "status" => "ok", "receipt" => coverage.receipt.as_str(), "data" => data })
    }

    fn symbol_outline(
        &mut self,
        resolved: &ResolvedSymbol,
        revision: &str,
        context: &Json,
    ) -> Outcome<Json> {
        if let Some(folded) = self.planned_fold(
            &resolved.path,
            &resolved.content,
            resolved.symbol.range,
            outline_minimum_characters() as i64,
            false,
        ) {
            let content = resolved.content.clone();
            return self.fold_result(&resolved.path, &content, folded, revision, context);
        }
        let alias = resolved.alias.clone().unwrap_or_default();
        self.read_symbol(
            &alias,
            revision,
            context,
            &ReadInput {
                target: alias.clone(),
                ..ReadInput::default()
            },
        )
    }

    fn read_range_alias(
        &mut self,
        alias: &Alias,
        input: &ReadInput,
        revision: &str,
        context: &Json,
    ) -> Outcome<Json> {
        let Alias::Range {
            alias: name,
            end,
            file_hash,
            path,
            start,
        } = alias
        else {
            unreachable!("a range alias")
        };
        let content = Arc::new(self.files.read(path)?.content);
        if sha256_hex(&content) != *file_hash {
            return Err(Failure::new(format!(
                "{name} is stale and cannot be relocated as text."
            )));
        }
        if requested_line_range(input) {
            return self.read_line_range(path, &content, input, revision, context);
        }
        if input.view.as_deref() == Some("symbol") {
            let parsed = parse_code(path, &content);
            if let Some(index) = enclosing_symbol(&parsed.symbols, (*start, *end)) {
                let registered =
                    self.aliases
                        .register_symbol(path, &content, &parsed.symbols[index]);
                let next = ReadInput {
                    target: registered.clone(),
                    ..ReadInput::default()
                };
                return self.read_symbol(&registered, revision, context, &next);
            }
        }
        let intervals = vec![(*start, *end)];
        let edit_targets = self.register_edit_targets(path, &content, revision, Some(&intervals));
        self.covered_content(
            path,
            &content,
            &intervals,
            context,
            "range",
            None,
            false,
            &edit_targets,
        )
    }

    fn raw(
        &mut self,
        path: &str,
        content: &[u8],
        revision: &str,
        context: &Json,
        fallback_reason: Option<&str>,
    ) -> Outcome<Json> {
        if let Some(delta) = self.folded_delta(path, content, context)? {
            return Ok(delta);
        }
        let mut end = content.len().min(MAXIMUM_RAW_CHARACTERS);
        while end > 0 && end < content.len() && (content[end] & 0xc0) == 0x80 {
            end -= 1;
        }
        let edit_targets = self.register_edit_targets(path, content, revision, None);
        self.covered_content(
            path,
            content,
            &[(0, end)],
            context,
            "raw",
            fallback_reason,
            content.len() > end,
            &edit_targets,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn covered_content(
        &mut self,
        path: &str,
        content: &[u8],
        intervals: &[Interval],
        context: &Json,
        view: &str,
        fallback_reason: Option<&str>,
        truncated: bool,
        edit_targets: &[EditTarget],
    ) -> Outcome<Json> {
        let coverage = self.register_coverage(path, content, intervals, context)?;
        Ok(content_result(
            path,
            content,
            intervals,
            view,
            &coverage.receipt,
            fallback_reason,
            truncated,
            edit_targets,
        ))
    }

    fn register_edit_targets(
        &mut self,
        path: &str,
        content: &[u8],
        _revision: &str,
        intervals: Option<&[Interval]>,
    ) -> Vec<EditTarget> {
        if content.len() > TWO_MIB {
            return Vec::new();
        }
        let parsed = parse_code(path, content);
        if !parsed.supported {
            return Vec::new();
        }
        edit_target_symbols(&parsed.symbols, intervals)
            .into_iter()
            .map(|index| {
                let symbol = &parsed.symbols[index];
                (
                    self.aliases.register_symbol(path, content, symbol),
                    symbol.qualified_name.clone(),
                )
            })
            .collect()
    }

    fn register_coverage(
        &mut self,
        path: &str,
        content: &[u8],
        intervals: &[Interval],
        context: &Json,
    ) -> Outcome<Registered> {
        self.aliases.observe(path, content, intervals);
        let (consumer, generation) = coverage_scope(context);
        let result = self.coverage.register(
            (&consumer, &generation),
            &sha256_hex(content),
            path,
            intervals,
        );
        self.journal.record_coverage(self.coverage.snapshot())?;
        Ok(result)
    }

    fn persist_aliases(&mut self) -> Outcome<()> {
        let entries = self.aliases.entries();
        self.journal.record_aliases(entries)
    }

    fn record_observation_audit(
        &mut self,
        tool: &str,
        requested_view: &str,
        result: &Json,
    ) -> Outcome<()> {
        if !is_ok(result) {
            return Ok(());
        }
        let data = result.get("data").cloned().unwrap_or(Json::Null);
        let targets = ["results", "items", "editTargets"]
            .iter()
            .find_map(|key| data.get(key).filter(|value| !matches!(value, Json::Null)))
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default();
        let aliases = targets
            .iter()
            .filter(|item| item.get("alias").and_then(Json::string_value).is_some())
            .count()
            + usize::from(data.get("alias").is_some_and(truthy));
        let rendered = data
            .get("view")
            .filter(|value| !matches!(value, Json::Null))
            .or_else(|| data.get("mode"))
            .and_then(Json::string_value)
            .unwrap_or("unknown")
            .to_string();
        self.journal.record_observation_audit(ObservationAudit {
            tool,
            requested_view,
            rendered_view: &rendered,
            bytes: data.stringify().len(),
            aliases,
            limited: data.get("limited") == Some(&Json::Bool(true))
                || data.get("truncated") == Some(&Json::Bool(true)),
        })
    }

    /// Search hits, kept whole by later folded views.
    fn point_at(&mut self, hits: Vec<(String, usize)>) -> Outcome<()> {
        if hits.is_empty() {
            return Ok(());
        }
        let mut by_path: Vec<(String, Vec<usize>)> = Vec::new();
        for (path, line) in hits {
            match by_path.iter_mut().find(|(known, _)| *known == path) {
                Some(entry) => entry.1.push(line),
                None => by_path.push((path, vec![line])),
            }
        }
        for (path, lines) in by_path {
            self.attention.point(&path, &lines);
        }
        self.journal.record_attention(self.attention.snapshot())
    }

    fn add_focus(&mut self, text: &str) {
        for found in FOCUS_NAME.find_iter(text) {
            let name = found.as_str().to_string();
            self.focus.retain(|known| *known != name);
            self.focus.push(name);
        }
        if self.focus.len() > 200 {
            let excess = self.focus.len() - 200;
            self.focus.drain(..excess);
        }
    }

    fn read_dependency_declaration(&self, input: &ReadInput) -> Outcome<Json> {
        let split = input.target.rfind('#').filter(|index| *index >= 1);
        let Some(split) = split.filter(|_| input.ranges.is_empty()) else {
            return Err(Failure::new(
                "Declaration view requires localFile#importBinding.member; use nextRead for continuation.",
            ));
        };
        let path = self.files.normalize_path(&input.target[..split])?;
        let name = &input.target[split + 1..];
        if !JS_TS_PATH.is_match(&path) || !DECLARATION_NAME.is_match(name) {
            return Err(Failure::new(
                "Declaration view requires a JS/TS file and a local import binding, optionally followed by member names.",
            ));
        }
        assert_mutable_workspace_path(&path)?;
        let file = self.files.read(&path)?;
        let real_root = std::fs::canonicalize(&self.files.root).map_err(|error| {
            Failure::io(&error, "realpath", std::path::Path::new(&self.files.root))
        })?;
        assert_mutable_workspace_path(&pathx::relative(
            &real_root.to_string_lossy(),
            &file.absolute.to_string_lossy(),
        ))?;
        if file.content.len() > TWO_MIB {
            return Err(Failure::new(
                "Declaration consumer exceeds the source read budget.",
            ));
        }
        let hash = sha256_hex(&file.content);
        let reply = self.compiler.declaration(&DeclarationTarget {
            root: &self.files.root,
            path: &path,
            name,
            hash: &hash,
            offset: input.offset,
        });
        match reply {
            CompilerReply::Unavailable(reason) => Err(Failure::new(format!(
                "Dependency declaration unavailable: {reason}. Inspect the local import/configuration or use run_task for runtime source investigation."
            ))),
            CompilerReply::Ok(result) => Ok(result),
        }
    }

    fn read_isolated_environment_image(
        &self,
        target: &str,
        context: &Json,
        signal: &Signal,
    ) -> Outcome<Option<Json>> {
        let isolated = self
            .task_contract
            .get("environment")
            .and_then(|environment| environment.get("isolated"))
            .and_then(Json::as_bool)
            == Some(true);
        if !isolated || !target.starts_with('/') || self.files.normalize_path(target).is_ok() {
            return Ok(None);
        }
        let directory =
            target.rsplit_once('/').map_or(
                "/",
                |(parent, _)| if parent.is_empty() { "/" } else { parent },
            );
        let external = WorkspaceFiles::new(directory);
        let mut result = read_workspace_image(&external, pathx::basename(target), context, signal)?;
        if let Some(image) = result.as_mut().filter(|image| is_ok(image))
            && let Some(data) = image.get_mut("data")
        {
            data.set("path", target);
        }
        Ok(result)
    }
}

fn is_ok(result: &Json) -> bool {
    result.get("status").and_then(Json::as_str) == Some("ok")
}

fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Num(value) => *value != 0.0 && !value.is_nan(),
        Json::Str(value) => !value.is_empty(),
        _ => true,
    }
}

fn fold_key(path: &str, content: &[u8], context: &Json) -> String {
    let (consumer, generation) = coverage_scope(context);
    [consumer, generation, path.to_string(), sha256_hex(content)].join("\0")
}

fn has_delta(range: Interval, uncovered: &[Interval]) -> bool {
    uncovered
        .iter()
        .any(|candidate| range.0 < candidate.1 && candidate.0 < range.1)
}

fn merged_intervals(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by_key(|interval| interval.0);
    let mut output: Vec<Interval> = Vec::new();
    for (start, end) in intervals {
        match output.last_mut() {
            Some(previous) if start <= previous.1 => previous.1 = previous.1.max(end),
            _ => output.push((start, end)),
        }
    }
    output
}

/// A Python body starts at its line when only indentation precedes it.
fn python_body_range(content: &[u8], range: Interval) -> Interval {
    let start = if range.0 > 0 {
        content[..range.0]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1)
    } else {
        0
    };
    let prefix = &content[start..range.0];
    if prefix.iter().all(|byte| *byte == b' ' || *byte == b'\t') {
        (start, range.1)
    } else {
        range
    }
}

/// Lines search results point at, per path.
fn search_hits(data: &Json) -> Vec<(String, usize)> {
    data.get("results")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|result| {
            let path = result.get("path").and_then(Json::string_value)?;
            let line = match result.get("matchLine") {
                Some(Json::Num(line)) => *line,
                _ => result
                    .get("lines")
                    .and_then(Json::as_array)
                    .and_then(|lines| lines.first())
                    .and_then(Json::as_f64)?,
            };
            (line != 0.0).then(|| (path.to_string(), line as usize))
        })
        .collect()
}

static FOCUS_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]{2,}").expect("pattern"));
static JS_TS_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.[cm]?[jt]sx?$").expect("pattern"));
static DECLARATION_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*){0,12}$").expect("pattern")
});

const MAXIMUM_IMAGE_BYTES: u64 = 5 * 1024 * 1024 * 3 / 4;

fn image_type(path: &str) -> Option<&'static str> {
    Some(match pathx::extname_lower(path).as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        _ => return None,
    })
}

fn read_workspace_image(
    files: &WorkspaceFiles,
    path: &str,
    context: &Json,
    signal: &Signal,
) -> Outcome<Option<Json>> {
    let Some(media_type) = image_type(path) else {
        return Ok(None);
    };
    let blocked = |message: &str| {
        Ok(Some(
            obj! { "status" => "blocked", "category" => "input", "message" => message },
        ))
    };
    if context
        .get("metadata")
        .and_then(|metadata| metadata.get("modelSupportsImages"))
        != Some(&Json::Bool(true))
    {
        return blocked("The current model does not support image input.");
    }
    if files.file_size(path)? > MAXIMUM_IMAGE_BYTES {
        return blocked(
            "Image exceeds the 5 MiB encoded image limit. Resize or crop it with a project tool before reading.",
        );
    }
    signal.check()?;
    let content = files.read(path)?.content;
    signal.check()?;
    if content.len() as u64 > MAXIMUM_IMAGE_BYTES || !matches_image_signature(&content, media_type)
    {
        return blocked("Image bytes do not match the supported format or size.");
    }
    let image = obj! { "type" => "image", "mediaType" => media_type, "data" => base64(&content) };
    Ok(Some(obj! {
        "status" => "ok",
        "data" => obj! { "path" => path, "view" => "image", "bytes" => content.len() },
        "content" => Json::Arr(vec![image]),
    }))
}

fn matches_image_signature(content: &[u8], media_type: &str) -> bool {
    match media_type {
        "image/png" => content.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => content.starts_with(&[255, 216, 255]),
        "image/gif" => content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a"),
        _ => content.starts_with(b"RIFF") && content.get(8..12) == Some(b"WEBP"),
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(ALPHABET[((value >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    #[test]
    fn finds_python_body_lines() {
        let content = b"def f():\n    return 1\n";
        assert_eq!(python_body_range(content, (13, 21)), (9, 21));
    }
}
