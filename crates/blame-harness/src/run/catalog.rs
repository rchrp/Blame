//! The project task catalog (`task-catalog.ts`, `native-task-catalog.ts`):
//! package scripts and native test commands, as ordered JSON items.

use crate::failure::{Failure, Outcome};
use crate::json::Json;
use crate::obj;
use crate::text::{js_trim, locale_compare, utf16_len};
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

pub type Task = Json;

pub fn text<'a>(task: &'a Task, key: &str) -> Option<&'a str> {
    task.get(key).and_then(Json::as_str)
}

pub fn task_id(task: &Task) -> &str {
    text(task, "task_id").unwrap_or("")
}

pub fn kind(task: &Task) -> &str {
    text(task, "kind").unwrap_or("")
}

pub fn cwd(task: &Task) -> &str {
    text(task, "cwd").unwrap_or(".")
}

/// An argv to run: `{ executable, args, cwd, packageManagerVersion? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Invocation {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub package_manager_version: Option<String>,
}

impl Invocation {
    pub fn to_json(&self) -> Json {
        obj! { "executable" => self.executable.as_str(), "args" => Json::Arr(self.args.iter().map(Json::from).collect()), "cwd" => self.cwd.as_str() }
            .with_opt("packageManagerVersion", self.package_manager_version.as_deref())
    }

    pub fn from_json(value: &Json) -> Option<Invocation> {
        Some(Invocation {
            executable: text(value, "executable")?.to_string(),
            args: value
                .get("args")?
                .as_array()?
                .iter()
                .filter_map(|arg| arg.as_str().map(str::to_string))
                .collect(),
            cwd: text(value, "cwd").unwrap_or(".").to_string(),
            package_manager_version: text(value, "packageManagerVersion").map(str::to_string),
        })
    }
}

static DISPLAY_SAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_@%+=:,./-]+$").expect("pattern"));

/// A POSIX-style rendering of an argv, for display only.
pub fn invocation_display(executable: &str, args: &[String]) -> String {
    std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .map(|word| {
            if DISPLAY_SAFE.is_match(word) {
                word.to_string()
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn is_validation_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("build" | "test" | "typecheck" | "lint"))
}

static PLAIN_COMPILER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:tsc|node[ \t]+(?:\./)?node_modules/typescript/bin/tsc)[ \t]+--noEmit(?:[ \t]+(?:-p|--project)[ \t]+[A-Za-z0-9_./-]+)?$").expect("pattern")
});

/// An exact no-emit TypeScript compiler command.
pub fn plain_compiler_check(command: &str) -> bool {
    PLAIN_COMPILER.is_match(js_trim(command))
}

pub fn read_task_catalog(
    root: &str,
    workspace_files: Option<&[String]>,
    dependency_task: bool,
) -> Vec<Task> {
    let files: Vec<String> = match workspace_files {
        Some(files) => files.to_vec(),
        None => walk(root),
    };
    let mut manifests: Vec<&String> = files
        .iter()
        .filter(|path| *path == "package.json" || path.ends_with("/package.json"))
        .collect();
    manifests.sort_by(|left, right| {
        if *left == "package.json" {
            std::cmp::Ordering::Less
        } else if *right == "package.json" {
            std::cmp::Ordering::Greater
        } else {
            locale_compare(left, right)
        }
    });
    let manifests: Vec<(String, Json)> = manifests
        .into_iter()
        .take(200)
        .filter_map(|file| {
            let content = std::fs::read(Path::new(root).join(file)).ok()?;
            let value = Json::parse(&String::from_utf8_lossy(&content)).ok()?;
            Some((file.clone(), value))
        })
        .collect();
    let native = native_task_catalog(root, &files);
    if manifests.is_empty() {
        return native;
    }
    let declared = manifests
        .iter()
        .find(|(file, _)| file == "package.json")
        .and_then(|(_, value)| text(value, "packageManager"))
        .map(str::to_string);
    let (manager, version) = detect_package_manager(root, declared.as_deref());
    let mut candidates: Vec<(Task, String, String)> = Vec::new();
    for (file, manifest) in &manifests {
        let directory = dirname(file);
        let name = text(manifest, "name")
            .and_then(|name| name.split('/').next_back())
            .map(js_trim)
            .filter(|name| !name.is_empty());
        let label = name
            .map(str::to_string)
            .unwrap_or_else(|| crate::pathx::basename(&directory).to_string());
        let scripts = match manifest.get("scripts") {
            Some(Json::Obj(entries)) => entries.clone(),
            _ => Vec::new(),
        };
        for (script, command) in scripts {
            let Some(command) = command.as_str() else {
                continue;
            };
            if js_trim(&script).is_empty()
                || utf16_len(&script) > 300
                || js_trim(command).is_empty()
                || utf16_len(command) > 2_000
            {
                continue;
            }
            candidates.push(task_candidate(
                &manager,
                version.as_deref(),
                &directory,
                &label,
                &script,
                command,
            ));
        }
    }
    let mut tasks: Vec<Task> = Vec::new();
    if dependency_task {
        tasks.push(dependency_task_item(&manager, version.as_deref()));
    }
    for (task, candidate, path) in &candidates {
        let count = candidates
            .iter()
            .filter(|(_, other, _)| other == candidate)
            .count();
        let mut task = task.clone();
        task.set(
            "task_id",
            if count == 1 {
                candidate.clone()
            } else {
                path.clone()
            },
        );
        tasks.push(task);
    }
    tasks.extend(native);
    tasks.sort_by(|left, right| locale_compare(task_id(left), task_id(right)));
    tasks
}

fn dirname(path: &str) -> String {
    path.rfind('/')
        .map_or(".".to_string(), |index| path[..index].to_string())
}

/// A workspace walk for a catalog read without the snapshot's files.
fn walk(root: &str) -> Vec<String> {
    let mut found = Vec::new();
    fn visit(root: &Path, relative: &str, found: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(root.join(relative)) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if [
                    ".git",
                    ".blame",
                    "node_modules",
                    "dist",
                    "build",
                    ".next",
                    ".venv",
                    "venv",
                    "target",
                ]
                .contains(&name.as_str())
                {
                    continue;
                }
                visit(root, &path, found);
            } else if kind.is_file() {
                found.push(path);
            }
        }
    }
    visit(Path::new(root), "", &mut found);
    found.sort();
    found
}

static SERVICE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(dev|preview|serve|start|watch)(:|$)").expect("pattern"));
static WATCH_FLAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)--watch(?-u:\b)").expect("pattern"));
static TYPECHECK_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)typecheck|check:type").expect("pattern"));
static TSC_NO_EMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^tsc[ \t]+--noEmit$").expect("pattern"));

fn task_kind(name: &str, command: &str) -> &'static str {
    let lower = name.to_lowercase();
    if SERVICE_NAME.is_match(name) || WATCH_FLAG.is_match(command) {
        return "service";
    }
    if lower.contains("test") {
        return "test";
    }
    if lower.contains("lint") {
        return "lint";
    }
    if TYPECHECK_NAME.is_match(name) || (name == "types" && TSC_NO_EMIT.is_match(js_trim(command)))
    {
        return "typecheck";
    }
    if lower.contains("build") {
        return "build";
    }
    "custom"
}

fn task_candidate(
    manager: &str,
    version: Option<&str>,
    directory: &str,
    label: &str,
    script: &str,
    command: &str,
) -> (Task, String, String) {
    let inferred = task_kind(script, command);
    let kind = if inferred != "service" && plain_compiler_check(command) {
        "typecheck"
    } else {
        inferred
    };
    let candidate = if directory == "." {
        script.to_string()
    } else {
        format!("{label}:{script}")
    };
    let path = if directory == "." {
        script.to_string()
    } else {
        format!("{directory}:{script}")
    };
    let task = obj! { "task_id" => candidate.as_str(), "script" => script, "kind" => kind }
        .with_opt(
            "validationScope",
            (kind == "typecheck").then_some("invocation_only"),
        )
        .with("command", command)
        .with("cwd", directory)
        .with("package_manager", manager)
        .with_opt("package_manager_version", version)
        .with("supportsFileSelection", kind == "test")
        .with("requiresNetwork", false)
        .with(
            "dependencyPolicy",
            if kind == "custom" || kind == "service" {
                "optional"
            } else {
                "required"
            },
        );
    (task, candidate, path)
}

fn dependency_arguments(manager: &str) -> Vec<String> {
    match manager {
        "bun" => vec!["install", "--frozen-lockfile"],
        "npm" => vec!["ci", "--prefer-offline", "--no-audit", "--no-fund"],
        "pnpm" => vec!["install", "--frozen-lockfile", "--prefer-offline"],
        _ => vec!["install", "--immutable", "--cached"],
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn dependency_task_item(manager: &str, version: Option<&str>) -> Task {
    let mut command = vec![manager.to_string()];
    command.extend(dependency_arguments(manager));
    obj! { "task_id" => "dependencies", "kind" => "dependencies", "command" => command.join(" "), "cwd" => ".", "package_manager" => manager }
        .with_opt("package_manager_version", version)
        .with("supportsFileSelection", false)
        .with("requiresNetwork", true)
        .with("dependencyPolicy", "required")
}

static DECLARED_MANAGER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(bun|npm|pnpm|yarn)@([^+\s]+)(?:\+.*)?$").expect("pattern"));

fn detect_package_manager(root: &str, declared: Option<&str>) -> (String, Option<String>) {
    if let Some(captures) = declared.and_then(|value| DECLARED_MANAGER.captures(js_trim(value))) {
        return (captures[1].to_string(), Some(captures[2].to_string()));
    }
    let name = declared.and_then(|value| value.split('@').next());
    if let Some(name @ ("bun" | "npm" | "pnpm" | "yarn")) = name {
        return (name.to_string(), None);
    }
    for (file, manager) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ] {
        if Path::new(root).join(file).exists() {
            return (manager.to_string(), None);
        }
    }
    ("npm".to_string(), None)
}

/// The argv of a task, with extra arguments for a test task.
pub fn task_invocation(task: &Task, args: &[String]) -> Outcome<Invocation> {
    if !args.is_empty() && kind(task) != "test" {
        return Err(Failure::new(
            "Extra arguments are supported only for project test tasks.",
        ));
    }
    if let Some(invocation) = task.get("invocation").and_then(Invocation::from_json) {
        let mut invocation = invocation;
        invocation.args.extend(args.iter().cloned());
        return Ok(invocation);
    }
    let Some(manager) = text(task, "package_manager") else {
        return Err(Failure::new(format!(
            "No command for task {}.",
            task_id(task)
        )));
    };
    let version = text(task, "package_manager_version").map(str::to_string);
    if kind(task) == "dependencies" {
        return Ok(Invocation {
            executable: manager.into(),
            args: dependency_arguments(manager),
            cwd: ".".into(),
            package_manager_version: version,
        });
    }
    let script = text(task, "script").unwrap_or(task_id(task)).to_string();
    let mut arguments = vec!["run".to_string(), script];
    if !args.is_empty() && manager == "npm" {
        arguments.push("--".into());
    }
    arguments.extend(args.iter().cloned());
    Ok(Invocation {
        executable: manager.into(),
        args: arguments,
        cwd: cwd(task).into(),
        package_manager_version: version,
    })
}

static PYTEST_SETUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*\[tool:pytest\]\s*$").expect("pattern"));
static PYTEST_PYPROJECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*\[tool\.pytest(?:\.ini_options)?\]\s*$").expect("pattern")
});

fn native_task_catalog(root: &str, files: &[String]) -> Vec<Task> {
    let native = [
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "pytest.ini",
        "setup.cfg",
        "pom.xml",
    ];
    let mut tasks: Vec<Task> = Vec::new();
    for path in files
        .iter()
        .filter(|path| native.contains(&crate::pathx::basename(path)) || path.ends_with(".csproj"))
        .take(200)
    {
        let directory = dirname(path);
        let name = crate::pathx::basename(path);
        let task = match name {
            "Cargo.toml" => Some(native_test("cargo", &["test"], &directory, None)),
            "go.mod" => Some(native_test("go", &["test", "./..."], &directory, None)),
            "pom.xml" => Some(native_test(
                "mvn",
                &["-f", "pom.xml", "test"],
                &directory,
                Some("maven:test".into()),
            )),
            _ if path.ends_with(".csproj") => Some(native_test(
                "dotnet",
                &["test", name],
                &directory,
                Some(format!("{name}:test")),
            )),
            _ => {
                let content = std::fs::read(Path::new(root).join(path))
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default();
                let pytest = name == "pytest.ini"
                    || if name == "setup.cfg" {
                        PYTEST_SETUP.is_match(&content)
                    } else {
                        PYTEST_PYPROJECT.is_match(&content)
                    };
                pytest.then(|| native_test("python3", &["-m", "pytest"], &directory, None))
            }
        };
        if let Some(task) = task {
            match tasks
                .iter_mut()
                .find(|known| task_id(known) == task_id(&task))
            {
                Some(slot) => *slot = task,
                None => tasks.push(task),
            }
        }
    }
    tasks
}

fn native_test(executable: &str, args: &[&str], directory: &str, label: Option<String>) -> Task {
    let label = label.unwrap_or_else(|| format!("{executable}:test"));
    let task_id = if directory == "." {
        label
    } else {
        format!("{directory}:{label}")
    };
    let mut command = vec![executable];
    command.extend(args);
    obj! {
        "task_id" => task_id,
        "kind" => "test",
        "command" => command.join(" "),
        "cwd" => directory,
        "invocation" => obj! { "executable" => executable, "args" => Json::Arr(args.iter().map(|arg| Json::from(*arg)).collect()), "cwd" => directory },
        "dependencyPolicy" => "optional",
        "requiresNetwork" => false,
        "supportsFileSelection" => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_scripts() {
        assert_eq!(task_kind("test:unit", "vitest"), "test");
        assert_eq!(task_kind("dev", "vite"), "service");
        assert_eq!(task_kind("types", "tsc --noEmit"), "typecheck");
        assert!(plain_compiler_check("tsc --noEmit -p tsconfig.json"));
        assert_eq!(
            invocation_display("npm", &["run".into(), "a b".into()]),
            "npm run 'a b'"
        );
    }
}
