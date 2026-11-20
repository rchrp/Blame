//! The harness's own functions on JSON arguments (`request` tool `unit`),
//! for the behavioural suite's tests that call one directly
//! (`packages/agent-runtime/src/harness/test-client/units.ts`). They are
//! named as the TypeScript harness named them and add no behaviour; this is
//! a test surface, not part of the tools.

use crate::failure::{Failure, Outcome};
use crate::json::Json;
use crate::obj;
use crate::run::{catalog, check, dependency, inspection, output, policy, report};

fn text(value: &Json) -> &str {
    value.as_str().unwrap_or("")
}

fn strings(value: &Json) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_string)
        .collect()
}

fn array(value: &Json) -> Vec<Json> {
    value.as_array().cloned().unwrap_or_default()
}

fn report_json(report: report::TestReport) -> Json {
    obj! { "counts" => report.counts.to_json(), "setupFailed" => report.setup_failed, "failures" => Json::Arr(report.failures) }
}

fn optional(value: Option<Json>) -> Json {
    value.unwrap_or(Json::Null)
}

pub fn call(name: &str, args: &[Json]) -> Outcome<Json> {
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Json::Null);
    Ok(match name {
        "blockedCommandReason" => {
            let environment = policy::CommandEnvironment::from_contract(&obj! { "environment" => arg(1) });
            policy::blocked_command_reason(text(&arg(0)), environment).map_or(Json::Null, Json::from)
        }
        "observeCheck" => {
            let result = arg(1);
            let all = result.get("all").and_then(Json::as_str).unwrap_or("").to_string();
            let command_result = check::CommandResult {
                all: &all,
                exit_code: result.get("exitCode").and_then(Json::as_f64).map(|code| code as i32),
                failed: result.get("failed").and_then(Json::as_bool).unwrap_or(false),
                interruption: match result.get("interruption").and_then(Json::as_str) {
                    Some("cancelled") => Some("cancelled"),
                    Some("timed_out") => Some("timed_out"),
                    Some("output_limit") => Some("output_limit"),
                    _ => None,
                },
            };
            let attributed = arg(4);
            let (sources, single) = match &attributed {
                Json::Arr(_) => (Some(strings(&attributed)), false),
                Json::Str(source) if !source.is_empty() => (Some(vec![source.clone()]), true),
                _ => (None, false),
            };
            let events = arg(5);
            let binding = events.is_object().then(|| report::NodeEventBinding {
                report: events.get("report").and_then(Json::as_str).map(str::to_string),
                invocation_id: events.get("invocationId").and_then(Json::as_str).unwrap_or("").to_string(),
                reporter_sha256: events.get("reporterSha256").and_then(Json::as_str).unwrap_or("").to_string(),
            });
            check::observe_check(text(&arg(0)), &command_result, text(&arg(2)), arg(3).as_bool().unwrap_or(false), sources.as_deref(), single, binding.as_ref())
        }
        "nodeEventEvidence" => {
            let binding = arg(0);
            let binding = report::NodeEventBinding {
                report: binding.get("report").and_then(Json::as_str).map(str::to_string),
                invocation_id: binding.get("invocationId").and_then(Json::as_str).unwrap_or("").to_string(),
                reporter_sha256: binding.get("reporterSha256").and_then(Json::as_str).unwrap_or("").to_string(),
            };
            report::node_event_evidence(&binding).map_or(Json::Null, |evidence| {
                obj! { "counts" => evidence.counts.to_json(), "failed" => evidence.failed, "evidence" => evidence.evidence }
            })
        }
        "checkReporting" => check::check_reporting(&arg(0), arg(1).as_bool() != Some(false)),
        "readTaskCatalog" => {
            let files = arg(1).as_array().map(|_| strings(&arg(1)));
            let dependency = arg(2).get("dependencyTaskAvailable") != Some(&Json::Bool(false));
            Json::Arr(catalog::read_task_catalog(text(&arg(0)), files.as_deref(), dependency))
        }
        "taskInvocation" => catalog::task_invocation(&arg(0), &strings(&arg(1)))?.to_json(),
        "validationScopePaths" => Json::Arr(output::validation_scope_paths(&strings(&arg(0)), &strings(&arg(1)), text(&arg(2))).into_iter().map(Json::from).collect()),
        "projectTestCommand" => {
            if text(&arg(3)) == "win32" {
                return Ok(Json::Null);
            }
            match check::project_test_command(text(&arg(0)), text(&arg(1)), &array(&arg(2))) {
                Some((task, args)) => obj! { "taskId" => task, "taskKind" => "test" }.with_opt("args", (!args.is_empty()).then(|| Json::Arr(args.into_iter().map(Json::from).collect()))),
                None => Json::Null,
            }
        }
        "runtimeTestScope" => {
            let input = arg(0);
            let selections: Vec<check::TypecheckSelection> = input
                .get("typecheckSelections")
                .map(array)
                .unwrap_or_default()
                .iter()
                .map(|item| check::TypecheckSelection { task: item.get("task").and_then(Json::as_str).unwrap_or("").to_string(), cwd: item.get("cwd").and_then(Json::as_str).unwrap_or(".").to_string() })
                .collect();
            optional(check::runtime_test_scope(
                &input.get("check").cloned().unwrap_or(Json::obj()),
                input.get("script").and_then(Json::as_str),
                &input.get("args").map(strings).unwrap_or_default(),
                &input.get("changedPaths").map(strings).unwrap_or_default(),
                &selections,
            ))
        }
        "shellInspectionRoutes" => {
            let location = arg(1);
            match inspection::shell_inspection_routes(text(&arg(0)), location.get("cwd").and_then(Json::as_str), location.get("root").and_then(Json::as_str).unwrap_or("")) {
                None => Json::Null,
                Some(routes) => Json::Arr(
                    routes
                        .into_iter()
                        .map(|route| match route {
                            inspection::Route::Search { command, request, .. } => obj! { "command" => command, "tool" => "search_code", "request" => request },
                            inspection::Route::Read { command, input, listing, tail_lines } => obj! { "command" => command, "tool" => "read_code", "input" => input }
                                .with_opt("listing", listing.then_some(true))
                                .with_opt("tailLines", tail_lines),
                        })
                        .collect(),
                ),
            }
        }
        "readOnlyInspection" => inspection::read_only_inspection(text(&arg(0))).map_or(Json::Null, Json::from),
        "currentValidationReport" => {
            let state = arg(0);
            let history = if matches!(arg(1), Json::Null) { state.get("validations").map(array).unwrap_or_default() } else { array(&arg(1)) };
            crate::checks::current_validation_report(&state, &history)
        }
        "validationStateAfterEdit" => optional(crate::checks::validation_state_after_edit(&arg(0), &array(&arg(1)), arg(2).as_str())),
        "latestFailedInvocations" => Json::Arr(crate::checks::latest_failed_invocations(&array(&arg(0)))),
        "failedLiteralCompilerInvocations" => Json::Arr(crate::checks::failed_literal_compiler_invocations(&array(&arg(0)))),
        "validationOutput" => output::validation_output(text(&arg(0)), text(&arg(1))),
        "alignDependencyPackages" => {
            let input = dependency::DependencyInput { action: "add".into(), packages: strings(&arg(0)), package_path: None };
            Json::Arr(dependency::aligned_packages(&input, arg(1).stringify().as_bytes()).into_iter().map(Json::from).collect())
        }
        "pathMatches" => {
            let limit = arg(2).as_f64().map_or(crate::search_results::DEFAULT_MATCH_LIMIT, |limit| limit as usize);
            Json::Arr(crate::search_results::path_matches(text(&arg(0)), &strings(&arg(1)), limit).into_iter().map(Json::from).collect())
        }
        "declarationQuery" => crate::search::declaration_query(text(&arg(0))).map_or(Json::Null, Json::from),
        "resolvePackageManager" => {
            let input = arg(0);
            let resolved = dependency::resolve_package_manager(
                input.get("name").and_then(Json::as_str).unwrap_or(""),
                input.get("version").and_then(Json::as_str),
                input.get("compatibility").and_then(Json::as_str) == Some("pnpm_same_major"),
            )?;
            obj! { "executable" => resolved.executable, "argsPrefix" => Json::Arr(resolved.args_prefix.into_iter().map(Json::from).collect()), "resolvedVersion" => resolved.resolved_version }
        }
        "parseRequiredChecks" => match crate::finish::validate_required_checks(&array(&arg(0))) {
            Ok(()) if arg(0).as_array().is_some() => obj! { "success" => true, "data" => arg(0) },
            Ok(()) => obj! { "success" => false, "message" => "Invalid input: expected array" },
            Err(failure) => obj! { "success" => false, "message" => failure.message },
        },
        "describeTools" => crate::tools::describe(&arg(0)),
        "lightToolContext" => crate::harness::light_tool_context(&arg(0)),
        // A tool input checked as the model's call checks it: `{ success,
        // data }` or `{ success: false, message }`.
        "parseInput" => {
            let schema = match text(&arg(0)) {
                "search_code" => crate::validate::search_code_schema(),
                "read_code" => crate::validate::read_code_schema(),
                "edit_code" => crate::validate::edit_code_schema(),
                "run_task" => crate::validate::run_task_schema_for(false),
                "run_task_analyze" => crate::validate::run_task_schema_for(true),
                "finish_task" => crate::validate::finish_task_schema(),
                other => return Err(Failure::new(format!("No input schema named {other}."))),
            };
            let lenient = arg(2).as_bool() == Some(true);
            let parsed = if lenient {
                crate::validate::parse_leniently(&schema, &arg(1))
            } else {
                let (data, issues) = schema.run(Some(&arg(1)));
                if issues.is_empty() { Ok(data.unwrap_or(Json::Null)) } else { Err(issues) }
            };
            match parsed {
                Ok(data) => obj! { "success" => true, "data" => data },
                Err(issues) => obj! { "success" => false, "message" => crate::validate::issues_message(&issues) },
            }
        }
        "parseTestReport" => optional(report::parse_test_report(text(&arg(0))).map(report_json)),
        "parseTestReports" => optional(report::parse_test_reports(&strings(&arg(0))).map(report_json)),
        "planScopedLightPatch" => Json::Arr(
            crate::patch::plan_scoped_light_patch(text(&arg(0)), text(&arg(1)), text(&arg(2)))?
                .into_iter()
                .map(|item| obj! { "start" => item.start, "end" => item.end, "replacement" => item.replacement })
                .collect(),
        ),
        // `[{ path, before, after }]` as text, restored last first.
        "restoreFiles" => {
            let mutations: Vec<crate::commit::Mutation> = array(&arg(1))
                .iter()
                .map(|item| crate::commit::Mutation {
                    path: item.get("path").and_then(Json::as_str).unwrap_or("").to_string(),
                    before: item.get("before").and_then(Json::as_str).map(|text| text.as_bytes().to_vec()),
                    after: item.get("after").and_then(Json::as_str).map(|text| text.as_bytes().to_vec()),
                    mode: None,
                })
                .collect();
            crate::commit::restore_files(&crate::files::WorkspaceFiles::new(text(&arg(0))), &mutations, arg(2).as_bool() == Some(true))?;
            Json::Null
        }
        // A catalogued test task's managed report, its invocation run to the
        // end in the workspace unless `{ run: false }`: `{ command,
        // invocation, run, report, nodeEvents }`, the report being what
        // `read` returns (one source or many).
        "managedTestRun" => {
            let Some(invocation) = catalog::Invocation::from_json(&arg(1)) else { return Ok(Json::Null) };
            let root = text(&arg(2)).to_string();
            let sequence = arg(3).as_f64().unwrap_or(1.0) as usize;
            let options = arg(4);
            let signal = crate::failure::Signal::default();
            let Some(managed) = crate::run::managed::managed_test_report(&arg(0), &invocation, &root, sequence, &signal) else { return Ok(Json::Null) };
            let run = if options.get("run") == Some(&Json::Bool(false)) {
                Json::Null
            } else {
                // The environment a task gets (without the test runner's own
                // NODE_TEST_CONTEXT, which would redirect Node's reporters).
                let environment = crate::run::environment::command_environment(&[], None, &managed.invocation.executable, &root);
                let outcome = crate::run::process::execute(&managed.invocation.executable, &managed.invocation.args, crate::run::process::CommandOptions {
                    cwd: root.clone(),
                    environment,
                    signal,
                    timeout_ms: options.get("timeoutMs").and_then(Json::as_f64).unwrap_or(60_000.0) as u64,
                    maximum_output_bytes: crate::run::process::DEFAULT_OUTPUT_LIMIT,
                })?;
                obj! { "all" => outcome.all, "exitCode" => outcome.exit_code.map_or(Json::Null, Json::from), "failed" => outcome.failed }
                    .with_opt("interruption", outcome.interruption)
            };
            let report = match managed.read() {
                Some(crate::run::managed::ReportSources::One(source)) => Json::from(source),
                Some(crate::run::managed::ReportSources::Many(sources)) => Json::Arr(sources.into_iter().map(Json::from).collect()),
                None => Json::Null,
            };
            let node_events = managed.node_events.as_ref().map_or(Json::Null, |(id, sha)| obj! { "invocationId" => id.as_str(), "reporterSha256" => sha.as_str() });
            obj! {
                "command" => managed.command.as_str(),
                "invocation" => managed.invocation.to_json(),
                "run" => run,
                "report" => report,
                "nodeEvents" => node_events,
            }
        }
        // `executeWorkspaceCommand(executable, args, { cwd, environment?,
        // timeoutMs?, maximumOutputBytes?, cancelAfterMs? })`: the command
        // run to its end with the provisioned package managers on its PATH;
        // `cancelAfterMs` aborts it as a signal would (0: before it starts).
        "executeWorkspaceCommand" => {
            let options = arg(2);
            let cwd = options.get("cwd").and_then(Json::as_str).unwrap_or(".").to_string();
            let environment = match options.get("environment").and_then(Json::as_object) {
                Some(entries) => crate::run::environment::with_provisioned_package_managers(
                    entries.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string()))).collect(),
                    &cwd,
                ),
                None => crate::run::environment::command_environment(&[], None, text(&arg(0)), &cwd),
            };
            let signal = crate::failure::Signal::default();
            if let Some(delay) = options.get("cancelAfterMs").and_then(Json::as_f64) {
                if delay <= 0.0 {
                    signal.abort();
                } else {
                    let later = signal.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(delay as u64));
                        later.abort();
                    });
                }
            }
            let outcome = crate::run::process::execute(text(&arg(0)), &strings(&arg(1)), crate::run::process::CommandOptions {
                cwd,
                environment,
                signal,
                timeout_ms: options.get("timeoutMs").and_then(Json::as_f64).map_or(crate::run::process::DEFAULT_TIMEOUT_MS, |ms| ms as u64),
                maximum_output_bytes: options.get("maximumOutputBytes").and_then(Json::as_f64).map_or(crate::run::process::DEFAULT_OUTPUT_LIMIT, |bytes| bytes as usize),
            })?;
            obj! { "all" => outcome.all, "exitCode" => outcome.exit_code.map_or(Json::Null, Json::from), "failed" => outcome.failed }
                .with_opt("interruption", outcome.interruption)
        }
        "shellCommand" => {
            let (executable, args) = crate::run::environment::shell_command(text(&arg(0)), arg(1).as_str());
            obj! { "executable" => executable, "args" => Json::Arr(args.into_iter().map(Json::from).collect()) }
        }
        "foldEconomics" => obj! {
            "foldCallCharacters" => crate::fold::fold_call_characters(),
            "foldBodyMinimumCharacters" => crate::fold::fold_body_minimum_characters(),
            "foldFileMinimumCharacters" => crate::fold::fold_file_minimum_characters(),
            "foldMarkerPattern" => crate::fold::FOLD_MARKER_PATTERN.as_str(),
        },
        // `fold(path, source, { lines, symbols }, window?)`: the plan and the
        // view of `window` (the whole file by default), symbols aliased
        // s1, s2… by qualified name as the read view numbers them.
        "fold" => {
            let source = text(&arg(1)).as_bytes().to_vec();
            let parsed = crate::syntax::parse_code(text(&arg(0)), &source);
            let window = match arg(3).as_array() {
                Some(range) if range.len() == 2 => (range[0].as_f64().unwrap_or(0.0) as usize, range[1].as_f64().unwrap_or(0.0) as usize),
                _ => (0, source.len()),
            };
            let attention = crate::attention::FoldAttention {
                lines: arg(2).get("lines").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_f64).map(|line| line as usize).collect(),
                symbols: strings(&arg(2).get("symbols").cloned().unwrap_or(Json::Null)).into_iter().collect(),
            };
            let plan = crate::fold::plan_fold(&source, &parsed, window, &attention);
            let mut aliases: Vec<String> = Vec::new();
            let view = crate::fold::render_fold(&source, &parsed, window, &plan, &mut |symbol| {
                let index = aliases.iter().position(|known| *known == symbol.qualified_name).unwrap_or_else(|| {
                    aliases.push(symbol.qualified_name.clone());
                    aliases.len() - 1
                });
                Some(format!("s{}", index + 1))
            });
            let pair = |(start, end): (usize, usize)| Json::Arr(vec![Json::from(start), Json::from(end)]);
            obj! {
                "plan" => obj! {
                    "removed" => plan.removed,
                    "markers" => plan.markers.len(),
                    "kept" => Json::Arr(plan.kept.iter().map(|(lines, reason)| obj! { "lines" => pair(*lines), "reason" => *reason }).collect()),
                },
                "view" => obj! {
                    "text" => view.text.as_str(),
                    "shown" => Json::Arr(view.shown.iter().map(|range| pair(*range)).collect()),
                    "markers" => Json::Arr(view.markers.iter().map(|(marker, line)| obj! {
                        "lines" => pair(marker.lines),
                        "hidden" => pair(marker.hidden),
                        "characters" => marker.characters,
                        "names" => Json::Arr(marker.names.iter().map(Json::from).collect()),
                        "line" => line.as_str(),
                    }.with_opt("summary", marker.summary.as_deref())).collect()),
                },
            }
        }
        "lineAlignedWindow" => {
            let range = array(&arg(1));
            let window = crate::fold::line_aligned_window(text(&arg(0)).as_bytes(), (
                range.first().and_then(Json::as_f64).unwrap_or(0.0) as usize,
                range.get(1).and_then(Json::as_f64).unwrap_or(0.0) as usize,
            ));
            Json::Arr(vec![Json::from(window.0), Json::from(window.1)])
        }
        "finishImages" => Json::Arr(crate::finish::finish_images(&arg(0))),
        "editTargetSymbols" => {
            let parsed = crate::syntax::parse_code(text(&arg(0)), text(&arg(1)).as_bytes());
            let intervals: Vec<(usize, usize)> = array(&arg(2))
                .iter()
                .filter_map(|range| { let range = range.as_array()?; Some((range.first()?.as_f64()? as usize, range.get(1)?.as_f64()? as usize)) })
                .collect();
            Json::Arr(
                crate::navigation::edit_target_symbols(&parsed.symbols, Some(&intervals))
                    .into_iter()
                    .map(|index| obj! { "name" => parsed.symbols[index].name.as_str(), "qualified_name" => parsed.symbols[index].qualified_name.as_str() })
                    .collect(),
            )
        }
        // An invocation-owned Vitest report: the hook's directory is made,
        // `files` (name to text, `{directory}` replaced by its path) are
        // written into it as an invocation would, and the report is read
        // between the two snapshots: `{ environment, report, evidence }`.
        "invocationTestReport" => {
            let root = text(&arg(0)).to_string();
            let Some(managed) = crate::run::managed::invocation_test_report(&root) else { return Ok(Json::Null) };
            let directory = managed.environment.iter().find(|(name, _)| name == "HARNESS_VITEST_REPORT_DIRECTORY").map(|(_, value)| value.clone()).unwrap_or_default();
            let files = crate::files::WorkspaceFiles::new(&root);
            let signal = crate::failure::Signal::default();
            let before = files.snapshot(&signal)?;
            for (name, content) in arg(1).as_object().into_iter().flatten() {
                let content = content.as_str().unwrap_or("").replace("{directory}", &directory);
                std::fs::write(std::path::Path::new(&directory).join(name), content).map_err(|error| Failure::new(error.to_string()))?;
            }
            let after = files.snapshot(&signal)?;
            match managed.read(&root, &before, &after) {
                Some((report, evidence)) => obj! { "directory" => directory.as_str(), "report" => report_json(report), "evidence" => evidence },
                None => obj! { "directory" => directory.as_str() },
            }
        }
        other => return Err(Failure::new(format!("No harness function named {other}."))),
    })
}
