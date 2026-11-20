//! Reports owned by one invocation (`managed-test-report.ts`,
//! `invocation-test-report.ts`, `environmentManifestEvidence`): a report
//! file or event channel the harness adds to a catalogued runner whose
//! version it identified, read back only from the directory it created.
//!
//! The Node reporter and the Vitest preload hook are the TypeScript
//! harness's own files (`node-event-reporter.js`,
//! `invocation-test-preload.js`), found in BLAME_HARNESS_NODE_ASSETS; their
//! hashes go into the evidence. Without that directory neither is added.

use super::catalog::{self, Invocation, Task, invocation_display};
use super::process::{CommandOptions, execute};
use super::report::{TestReport, parse_test_report, parse_test_reports};
use crate::failure::Signal;
use crate::files::{WorkspaceFiles, WorkspaceSnapshot};
use crate::identity::sha256_hex;
use crate::json::Json;
use crate::obj;
use crate::pathx;
use crate::text::{js_trim, utf16_prefix};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

fn asset(name: &str) -> Option<PathBuf> {
    let directory = std::env::var("BLAME_HARNESS_NODE_ASSETS")
        .ok()
        .filter(|directory| !directory.is_empty())?;
    let path = Path::new(&directory).join(name);
    path.is_file().then_some(path)
}

/// `fs.mkdtemp(prefix)`: six random characters after the prefix.
pub fn make_temporary_directory(prefix: &Path) -> Option<PathBuf> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for _ in 0..100 {
        let random = super::output::uuid();
        let suffix: String = random
            .bytes()
            .filter(u8::is_ascii_hexdigit)
            .take(6)
            .map(|byte| ALPHABET[byte as usize % ALPHABET.len()] as char)
            .collect();
        let path = PathBuf::from(format!("{}{suffix}", prefix.to_string_lossy()));
        match std::fs::create_dir(&path) {
            Ok(()) => return Some(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq)]
enum Reader {
    Single,
    Surefire,
}

pub struct ManagedReport {
    pub invocation: Invocation,
    pub command: String,
    directory: PathBuf,
    path: PathBuf,
    reader: Reader,
    /// `{ invocationId, reporterSha256 }` for the Node adapter.
    pub node_events: Option<(String, String)>,
}

pub enum ReportSources {
    One(String),
    Many(Vec<String>),
}

impl ManagedReport {
    pub fn read(&self) -> Option<ReportSources> {
        match self.reader {
            Reader::Single => read_owned(&self.directory, &self.path).map(ReportSources::One),
            Reader::Surefire => read_owned_reports(&self.directory).map(ReportSources::Many),
        }
    }
}

static REPORTER_FLAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:--test-reporter|--test-isolation|--watch)").expect("pattern")
});
static PYTHON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^python(?:3(?:\.\d+)*)?$").expect("pattern"));
static PYTEST_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pytest\s+(\d+)").expect("pattern"));
static DOTNET_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+)\.").expect("pattern"));
static MAVEN_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Apache Maven (\d+)\.").expect("pattern"));
static SUREFIRE_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^TEST-[^/\\]+\.xml$").expect("pattern"));

fn supported_major(output: &str, expression: &Regex, minimum: u64, maximum: u64) -> bool {
    expression
        .captures(output)
        .and_then(|captures| captures[1].parse::<u64>().ok())
        .is_some_and(|major| (minimum..=maximum).contains(&major))
}

/// Adds a report only to a catalogued runner whose installed version was identified.
pub fn managed_test_report(
    task: &Task,
    invocation: &Invocation,
    root: &str,
    sequence: usize,
    signal: &Signal,
) -> Option<ManagedReport> {
    if catalog::kind(task) != "test" {
        return None;
    }
    let executable = pathx::basename(&invocation.executable).to_string();
    let declared = task
        .get("invocation")
        .is_some_and(|value| value.is_object());
    let args = &invocation.args;
    // (name, report file, version argv, supported, how the args change, reader)
    type Adapt = Box<dyn Fn(&[String], &Path, &Path) -> Vec<String>>;
    type Supported = Box<dyn Fn(&str) -> bool>;
    let (name, file, version_executable, version_args, supported, adapt, reader): (
        &str,
        &str,
        String,
        Vec<String>,
        Supported,
        Adapt,
        Reader,
    );
    let reporter = asset("node-event-reporter.js");
    let native =
        declared && executable == "node" && args.first().map(String::as_str) == Some("--test");
    let npm = !declared
        && catalog::text(task, "package_manager") == Some("npm")
        && catalog::text(task, "command") == Some("node --test")
        && args.first().map(String::as_str) == Some("run")
        && args.get(1).map(String::as_str) == catalog::text(task, "script")
        && (args.len() == 2 || args.get(2).map(String::as_str) == Some("--"));
    if (native || npm) && !args.iter().any(|arg| REPORTER_FLAG.is_match(arg)) && reporter.is_some()
    {
        let reporter = reporter
            .clone()
            .expect("reporter")
            .to_string_lossy()
            .into_owned();
        name = "node";
        file = "events.jsonl";
        version_executable = if native {
            invocation.executable.clone()
        } else {
            "node".into()
        };
        version_args = vec!["--version".into()];
        supported = Box::new(|output| js_trim(output).starts_with("v24."));
        adapt = Box::new(move |args, _, report| {
            let extra = vec![
                "--test-reporter=spec".to_string(),
                format!("--test-reporter={reporter}"),
                "--test-reporter-destination=stdout".into(),
                format!("--test-reporter-destination={}", report.to_string_lossy()),
            ];
            if native {
                std::iter::once(args[0].clone())
                    .chain(extra)
                    .chain(args[1..].iter().cloned())
                    .collect()
            } else {
                vec![args[0].clone(), args[1].clone(), "--".into()]
                    .into_iter()
                    .chain(extra)
                    .chain(args.iter().skip(3).cloned())
                    .collect()
            }
        });
        reader = Reader::Single;
    } else if !declared {
        return None;
    } else if PYTHON.is_match(&executable)
        && args.len() == 2
        && args[0] == "-m"
        && args[1] == "pytest"
    {
        name = "pytest";
        file = "junit.xml";
        version_executable = invocation.executable.clone();
        version_args = vec!["-m".into(), "pytest".into(), "--version".into()];
        supported = Box::new(|output| supported_major(output, &PYTEST_VERSION, 6, 9));
        adapt = Box::new(|args, _, report| {
            args.iter()
                .cloned()
                .chain([format!("--junitxml={}", report.to_string_lossy())])
                .collect()
        });
        reader = Reader::Single;
    } else if executable == "dotnet" && args.first().map(String::as_str) == Some("test") {
        name = "vstest";
        file = "results.trx";
        version_executable = invocation.executable.clone();
        version_args = vec!["--version".into()];
        supported = Box::new(|output| supported_major(output, &DOTNET_VERSION, 6, 10));
        adapt = Box::new(|args, directory, _| {
            args.iter()
                .cloned()
                .chain([
                    "--logger".into(),
                    "trx;LogFileName=results.trx".into(),
                    "--results-directory".into(),
                    directory.to_string_lossy().into_owned(),
                ])
                .collect()
        });
        reader = Reader::Single;
    } else if (executable == "mvn" || executable == "mvnw") && args.iter().any(|arg| arg == "test")
    {
        name = "surefire";
        file = "TEST-*.xml";
        version_executable = invocation.executable.clone();
        version_args = vec!["--version".into()];
        supported = Box::new(|output| supported_major(output, &MAVEN_VERSION, 3, 4));
        adapt = Box::new(|args, directory, _| {
            args.iter()
                .cloned()
                .chain([format!(
                    "-Dsurefire.reportsDirectory={}",
                    directory.to_string_lossy()
                )])
                .collect()
        });
        reader = Reader::Surefire;
    } else {
        return None;
    }
    let cwd = pathx::resolve(root, &invocation.cwd);
    let environment = super::environment::command_environment(&[], None, &version_executable, &cwd);
    let version = execute(
        &version_executable,
        &version_args,
        CommandOptions {
            cwd,
            environment,
            signal: signal.clone(),
            timeout_ms: 5_000,
            maximum_output_bytes: 4_096,
        },
    )
    .ok()?;
    if version.failed || !supported(&version.all) {
        return None;
    }
    let parent = Path::new(root)
        .join(".blame")
        .join("harness")
        .join("test-results");
    std::fs::create_dir_all(&parent).ok()?;
    let directory = make_temporary_directory(
        &parent.join(format!("{name}-{}-{sequence}-", std::process::id())),
    )?;
    let path = directory.join(file);
    let args = adapt(&invocation.args, &directory, &path);
    let invocation = Invocation {
        args,
        ..invocation.clone()
    };
    let node_events = (name == "node").then(|| {
        let reporter = asset("node-event-reporter.js")
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        (
            directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            sha256_hex(&reporter),
        )
    });
    Some(ManagedReport {
        command: invocation_display(&invocation.executable, &invocation.args),
        invocation,
        directory,
        path,
        reader,
        node_events,
    })
}

fn read_owned(directory: &Path, path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    let owned = std::fs::canonicalize(directory).ok()?;
    let actual = std::fs::canonicalize(path).ok()?;
    if !actual.starts_with(&owned) || actual == owned {
        return None;
    }
    Some(String::from_utf8_lossy(&std::fs::read(actual).ok()?).into_owned())
}

fn read_owned_reports(directory: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| SUREFIRE_FILE.is_match(name))
        .collect();
    names.sort();
    names.truncate(1_000);
    let reports: Option<Vec<String>> = names
        .iter()
        .map(|name| read_owned(directory, &directory.join(name)))
        .collect();
    reports.filter(|reports| !reports.is_empty())
}

/// The Vitest preload hook of a test invocation, and where its reports land.
pub struct InvocationReport {
    pub environment: Vec<(String, String)>,
    directory: PathBuf,
    hook_hash: String,
}

pub fn invocation_test_report(root: &str) -> Option<InvocationReport> {
    let hook = asset("invocation-test-preload.js")?;
    let hook_hash = sha256_hex(&std::fs::read(&hook).ok()?);
    let parent = Path::new(root)
        .join(".blame")
        .join("harness")
        .join("test-results");
    std::fs::create_dir_all(&parent).ok()?;
    let directory = make_temporary_directory(&parent.join("vitest-invocation-"))?;
    // Node's --import takes a file URL; JSON quoting keeps spaces in NODE_OPTIONS.
    let url = format!(
        "file://{}",
        hook.to_string_lossy()
            .replace('%', "%25")
            .replace(' ', "%20")
    );
    let previous = std::env::var("NODE_OPTIONS").unwrap_or_default();
    let options = js_trim(&format!("{previous} --import={}", crate::json::quote(&url))).to_string();
    Some(InvocationReport {
        environment: vec![
            ("NODE_OPTIONS".into(), options),
            (
                "HARNESS_VITEST_REPORT_DIRECTORY".into(),
                directory.to_string_lossy().into_owned(),
            ),
        ],
        directory,
        hook_hash,
    })
}

static START_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-f0-9-]+\.start\.json$").expect("pattern"));

impl InvocationReport {
    /// The reports the hook wrote for this invocation, bound to the files
    /// they name before and after it ran.
    pub fn read(
        &self,
        root: &str,
        before: &WorkspaceSnapshot,
        after: &WorkspaceSnapshot,
    ) -> Option<(TestReport, Json)> {
        let mut starts: Vec<String> = std::fs::read_dir(&self.directory)
            .ok()?
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| START_FILE.is_match(name))
            .collect();
        starts.sort();
        if starts.is_empty() || starts.len() > 32 {
            return None;
        }
        let owned_directory = std::fs::canonicalize(&self.directory).ok()?;
        let mut bytes = 0u64;
        let mut owned = |name: &str| -> Option<String> {
            let path = self.directory.join(name);
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            bytes += metadata.len();
            if !metadata.is_file()
                || bytes > 2 * 1024 * 1024
                || !std::fs::canonicalize(&path)
                    .ok()?
                    .starts_with(&owned_directory)
            {
                return None;
            }
            Some(String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned())
        };
        let (mut reports, mut invocations, mut reported_files) = (Vec::new(), Vec::new(), 0usize);
        for name in &starts {
            let start = Json::parse(&owned(name)?).ok()?;
            let end = Json::parse(&owned(&name.replace(".start.", ".end."))?).ok()?;
            let id = &name[..name.len() - 11];
            let runner = start.get("runner");
            let exit = end
                .get("exitCode")
                .and_then(Json::as_f64)
                .filter(|code| code.fract() == 0.0)?;
            let mut without_exit = end.clone();
            without_exit.remove("exitCode");
            if start.get("format").and_then(Json::as_str) != Some("blame-vitest-invocation-v1")
                || runner
                    .and_then(|runner| runner.get("version"))
                    .and_then(Json::as_str)
                    != Some("3.2.4")
                || runner
                    .and_then(|runner| runner.get("name"))
                    .and_then(Json::as_str)
                    != Some("vitest")
                || start.get("id").and_then(Json::as_str) != Some(id)
                || start.stringify() != without_exit.stringify()
            {
                return None;
            }
            let text = owned(&format!("{id}.report.json"))?;
            let report = parse_test_report(&text)?;
            let parsed = Json::parse(&text).ok()?;
            let results = parsed.get("testResults")?.as_array()?;
            if results.len() > 128 {
                return None;
            }
            let mut files = Vec::new();
            for file in results {
                let absolute = file.get("name").and_then(Json::as_str).unwrap_or("");
                let path =
                    pathx::relative(root, &pathx::resolve(root, absolute)).replace('\\', "/");
                if path.is_empty() || pathx::escapes(&path) {
                    return None;
                }
                let state = |snapshot: &WorkspaceSnapshot| {
                    snapshot
                        .file_states
                        .iter()
                        .find(|(known, _)| *known == path)
                        .map(|(_, hash)| hash.clone())
                };
                let (old, new) = (state(before), state(after));
                files.push(obj! {
                    "path" => path.as_str(),
                    "cases" => file.get("assertionResults").and_then(Json::as_array).map_or(Json::Null, |cases| Json::from(cases.len())),
                    "sourceSha256Before" => old.clone().map_or(Json::Null, Json::from),
                    "sourceSha256After" => new.clone().map_or(Json::Null, Json::from),
                    "unchanged" => old.is_some() && old == new,
                });
            }
            reported_files += files.len();
            // A child's failed exit cannot hide behind a successful wrapper.
            if exit != 0.0 && !report.setup_failed && report.counts.failed == 0 {
                return None;
            }
            let args: Vec<Json> = start
                .get("args")
                .and_then(Json::as_array)
                .cloned()
                .unwrap_or_default();
            let mut invocation = end.clone();
            invocation.set(
                "args",
                Json::Arr(
                    args.iter()
                        .take(32)
                        .map(|arg| Json::from(utf16_prefix(arg.as_str().unwrap_or(""), 256)))
                        .collect(),
                ),
            );
            invocation.set(
                "argsSha256",
                sha256_hex(Json::Arr(args.clone()).stringify().as_bytes()),
            );
            invocation.set("argsTruncated", args.len() > 32);
            invocation.set("reportSha256", sha256_hex(text.as_bytes()));
            let file_count = files.len();
            files.truncate(16);
            invocation.set("files", Json::Arr(files));
            invocation.set("fileCount", file_count);
            invocation.set("filesTruncated", file_count > 16);
            reports.push(text);
            invocations.push(invocation);
        }
        let combined = parse_test_reports(&reports)?;
        let count = invocations.len();
        invocations.truncate(8);
        let evidence = obj! {
            "invocationId" => pathx::relative(root, &self.directory.to_string_lossy()),
            "hookSha256" => self.hook_hash.as_str(),
            "reportedFileCount" => reported_files,
            "invocations" => Json::Arr(invocations),
            "invocationCount" => count,
            "invocationsTruncated" => count > 8,
            "typeFileSelection" => "unknown",
            "boundary" => "Invocation-owned Vitest 3.2.4 reported cases; runtime versus configured typecheck mode is not established. Counts may include repeated invocations. File hashes bind observed tests, not dependencies or typecheck selection. No source admission or user acceptance.",
        };
        Some((combined, evidence))
    }
}

static ENVIRONMENT_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$")
        .expect("pattern")
});

/// Manifest and lockfile bytes only: never installed dependencies.
pub fn environment_manifest_evidence(files: &WorkspaceFiles, paths: &[String]) -> Json {
    let entries: Vec<(String, String)> = paths
        .iter()
        .filter(|path| path.ends_with("package.json") || ENVIRONMENT_PATH.is_match(path))
        .filter_map(|path| {
            files
                .read(path)
                .ok()
                .map(|file| (path.clone(), sha256_hex(&file.content)))
        })
        .collect();
    let mut lines: Vec<String> = entries
        .iter()
        .map(|(path, hash)| format!("{path}\0{hash}"))
        .collect();
    lines.sort_by(|left, right| crate::text::utf16_compare(left, right));
    obj! {
        "revisionId" => format!("env_{}", &sha256_hex(lines.join("\n").as_bytes())[..32]),
        "manifests" => Json::Arr(entries.iter().take(128).map(|(path, hash)| obj! { "path" => path.as_str(), "sha256" => hash.as_str() }).collect()),
        "truncated" => entries.len() > 128,
        "boundary" => "Manifest and lockfile bytes; installed dependencies, services, other variables and dependency coverage remain unknown.",
    }
}
