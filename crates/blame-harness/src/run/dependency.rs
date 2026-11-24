//! The dependency operation (`light-dependencies.ts`,
//! `package-manager-runtime.ts`): one package-manager mutation of a Node
//! manifest, under the session's turn and the workspace lock, rolled back
//! whole when it fails. Package managers come from the runtime's
//! provisioned roots, the bundled packages (BLAME_HARNESS_NODE_MODULES: the
//! node_modules the TypeScript harness resolves them from) or PATH; never
//! from Corepack or a download.

use super::catalog::{self, read_task_catalog};
use super::environment::{
    newest, numeric_compare, package_manager_roots, process_environment,
    workspace_command_environment,
};
use super::failure::DEPENDENCY_SECTIONS;
use super::output::bounded_diagnostic;
use super::process::{CommandOptions, DEFAULT_OUTPUT_LIMIT, execute};
use crate::commit::{Mutation, locked, restore_files};
use crate::failure::{Failure, Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::json::Json;
use crate::present::redact_secrets;
use crate::text::js_trim;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

pub struct DependencyInput {
    pub action: String,
    pub packages: Vec<String>,
    pub package_path: Option<String>,
}

pub enum DependencyResult {
    Applied {
        changed_paths: Vec<String>,
        output: String,
    },
    Blocked {
        category: &'static str,
        message: String,
    },
}

pub fn mutate(
    files: &WorkspaceFiles,
    session: &str,
    input: &DependencyInput,
    signal: &Signal,
) -> Outcome<DependencyResult> {
    let _turn = crate::turn::acquire(
        &files.root,
        session,
        crate::turn::Holder {
            label: "an edit or a read".into(),
            run: None,
        },
    )?;
    let _lock = locked(files)?;
    let snapshot = files.snapshot(signal)?;
    let manifest = manifest_path(files, input.package_path.as_deref())?;
    let Some(file) = optional(files, &manifest)? else {
        return Ok(DependencyResult::Blocked {
            category: "input",
            message: format!(
                "No Node manifest at {manifest}. Use run_task with the native package manager for other ecosystems."
            ),
        });
    };
    let before = snapshot_dependency_files(files, &snapshot.files)?;
    let run = (|| -> Outcome<(Option<i32>, String)> {
        let packages = aligned_packages(input, &file);
        let task = read_task_catalog(&files.root, Some(&snapshot.files), true)
            .into_iter()
            .find(|task| catalog::kind(task) == "dependencies")
            .ok_or_else(|| Failure::new("No package manager was detected."))?;
        let name = catalog::text(&task, "package_manager")
            .unwrap_or("npm")
            .to_string();
        let version = catalog::text(&task, "package_manager_version").map(str::to_string);
        let resolved = resolve_package_manager(&name, version.as_deref(), name == "pnpm")?;
        let mut args = resolved.args_prefix.clone();
        args.extend(dependency_arguments(&name, &input.action, &packages));
        let cwd = Path::new(&files.resolve_for_write(&manifest)?)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_else(|| files.root.clone());
        let outcome = execute(
            &resolved.executable,
            &args,
            CommandOptions {
                cwd,
                environment: workspace_command_environment(process_environment(), None),
                signal: signal.clone(),
                timeout_ms: 120_000,
                maximum_output_bytes: DEFAULT_OUTPUT_LIMIT,
            },
        )?;
        Ok((outcome.exit_code, redact_secrets(js_trim(&outcome.all))))
    })();
    let (exit_code, output) = match run {
        Ok(run) => run,
        Err(failure) => (None, failure.message),
    };
    if exit_code != Some(0) {
        restore_files(files, &before, false)?;
        return Ok(DependencyResult::Blocked {
            category: failure_category(&output),
            message: bounded_diagnostic(&output, "Dependency mutation failed.", 16_000),
        });
    }
    let mut changed_paths = Vec::new();
    for mutation in &before {
        let current = optional(files, &mutation.path)?;
        if current.as_deref() != mutation.before.as_deref() {
            changed_paths.push(mutation.path.clone());
        }
    }
    Ok(DependencyResult::Applied {
        changed_paths,
        output,
    })
}

fn optional(files: &WorkspaceFiles, path: &str) -> Outcome<Option<Vec<u8>>> {
    match files.read(path) {
        Ok(file) => Ok(Some(file.content)),
        Err(failure) if failure.is_missing() => Ok(None),
        Err(failure) => Err(failure),
    }
}

fn manifest_path(files: &WorkspaceFiles, package_path: Option<&str>) -> Outcome<String> {
    let Some(package_path) = package_path.filter(|path| !path.is_empty()) else {
        return Ok("package.json".into());
    };
    let normalized = files.normalize_path(package_path)?;
    Ok(if normalized.ends_with("package.json") {
        normalized
    } else {
        format!(
            "{}/package.json",
            normalized.strip_suffix('/').unwrap_or(&normalized)
        )
    })
}

fn snapshot_dependency_files(files: &WorkspaceFiles, paths: &[String]) -> Outcome<Vec<Mutation>> {
    let manifests: Vec<&String> = paths
        .iter()
        .filter(|path| path.ends_with("package.json"))
        .collect();
    let mut candidates: Vec<String> = manifests.iter().map(|path| path.to_string()).collect();
    let mut directories: Vec<String> = Vec::new();
    for manifest in &manifests {
        let directory = manifest
            .rfind('/')
            .map_or(".".to_string(), |index| manifest[..index].to_string());
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    for directory in &directories {
        for lockfile in [
            "bun.lock",
            "bun.lockb",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
        ] {
            candidates.push(if directory == "." {
                lockfile.to_string()
            } else {
                format!("{directory}/{lockfile}")
            });
        }
    }
    candidates.sort();
    candidates.dedup();
    let mut mutations = Vec::new();
    for path in candidates {
        let file = match files.read(&path) {
            Ok(file) => Some(file),
            Err(failure) if failure.is_missing() => None,
            Err(failure) => return Err(failure),
        };
        mutations.push(Mutation {
            after: None,
            mode: file.as_ref().map(|file| file.mode),
            before: file.map(|file| file.content),
            path,
        });
    }
    Ok(mutations)
}

fn dependency_arguments(manager: &str, action: &str, packages: &[String]) -> Vec<String> {
    let packages: Vec<String> = if action == "remove" {
        packages
            .iter()
            .map(|value| package_name(value).to_string())
            .collect()
    } else {
        packages.to_vec()
    };
    let verb = if manager == "npm" {
        if action == "add" {
            "install"
        } else {
            "uninstall"
        }
    } else {
        action
    };
    std::iter::once(verb.to_string()).chain(packages).collect()
}

fn package_name(value: &str) -> &str {
    match value.rfind('@') {
        Some(separator) if separator > 0 => &value[..separator],
        _ => value,
    }
}

static SEMANTIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?").expect("pattern"));

/// Prisma's packages move together: an unversioned one takes the declared version.
pub fn aligned_packages(input: &DependencyInput, manifest: &[u8]) -> Vec<String> {
    if input.action != "add" {
        return input.packages.clone();
    }
    let Ok(value) = Json::parse(&String::from_utf8_lossy(manifest)) else {
        return input.packages.clone();
    };
    let version = ["@prisma/client", "prisma"].iter().find_map(|name| {
        DEPENDENCY_SECTIONS.iter().find_map(|section| {
            value
                .get(section)
                .and_then(|section| section.get(name))
                .and_then(Json::as_str)
                .and_then(|declared| SEMANTIC.find(declared))
                .map(|found| found.as_str().to_string())
        })
    });
    let Some(version) = version else {
        return input.packages.clone();
    };
    input
        .packages
        .iter()
        .map(|value| {
            if (value == "prisma" || value.starts_with("@prisma/"))
                && value.rfind('@').is_none_or(|index| index == 0)
            {
                format!("{value}@{version}")
            } else {
                value.clone()
            }
        })
        .collect()
}

static ENVIRONMENT_FAILURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)EAI_AGAIN|ECONN|ENET|ENOENT|EACCES|permission|network|PACKAGE_MANAGER_UNAVAILABLE",
    )
    .expect("pattern")
});

fn failure_category(diagnostic: &str) -> &'static str {
    if ENVIRONMENT_FAILURE.is_match(diagnostic) {
        "environment"
    } else {
        "code"
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedManager {
    pub executable: String,
    pub args_prefix: Vec<String>,
    pub resolved_version: String,
}

/// The manager a project pins (exactly, or for pnpm one of the same major).
pub fn resolve_package_manager(
    name: &str,
    version: Option<&str>,
    same_major: bool,
) -> Outcome<ResolvedManager> {
    let exact = match version {
        None => newest_candidate(provisioned_candidates(name))
            .or_else(|| system_manager(name, None))
            .or_else(|| bundled_manager(name, None)),
        Some(version) => provisioned_manager(name, version)
            .or_else(|| bundled_manager(name, Some(version)))
            .or_else(|| system_manager(name, Some(version))),
    };
    if let Some(exact) = exact {
        return Ok(exact);
    }
    if let (true, "pnpm", Some(requested)) = (same_major, name, version.and_then(semantic_version))
    {
        let mut candidates: Vec<ResolvedManager> = provisioned_candidates(name);
        candidates.extend(bundled_manager(name, None));
        candidates.extend(bundled_package(name, "pnpm-legacy", None));
        candidates.extend(system_manager(name, None));
        let mut compatible: Vec<(ResolvedManager, (u64, u64, u64))> = Vec::new();
        for candidate in candidates {
            if let Some(found) =
                semantic_version(&candidate.resolved_version).filter(|found| found.0 == requested.0)
                && !compatible.iter().any(|(known, _)| {
                    known.executable == candidate.executable
                        && known.resolved_version == candidate.resolved_version
                })
            {
                compatible.push((candidate, found));
            }
        }
        compatible.sort_by_key(|(_, found)| {
            (found.1.abs_diff(requested.1), found.2.abs_diff(requested.2))
        });
        if let Some((manager, _)) = compatible.into_iter().next() {
            return Ok(manager);
        }
    }
    let identity = version.map_or(name.to_string(), |version| format!("{name}@{version}"));
    let compatibility = if same_major && name == "pnpm" {
        " No trusted stable pnpm from the requested major is available."
    } else {
        ""
    };
    Err(Failure::new(format!(
        "PACKAGE_MANAGER_UNAVAILABLE:{identity} is not provisioned in this runtime.{compatibility} Corepack and package-manager self-downloads are disabled."
    )))
}

fn semantic_version(value: &str) -> Option<(u64, u64, u64)> {
    static SEMVER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$").expect("pattern")
    });
    let captures = SEMVER.captures(value)?;
    Some((
        captures[1].parse().ok()?,
        captures[2].parse().ok()?,
        captures[3].parse().ok()?,
    ))
}

fn newest_candidate(candidates: Vec<ResolvedManager>) -> Option<ResolvedManager> {
    let version = newest(
        candidates
            .iter()
            .map(|candidate| candidate.resolved_version.clone())
            .collect(),
    )?;
    let mut ordered = candidates;
    ordered.sort_by(|left, right| numeric_compare(&right.resolved_version, &left.resolved_version));
    ordered
        .into_iter()
        .find(|candidate| candidate.resolved_version == version)
}

fn executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && crate::platform::executable(&metadata))
}

fn manager_version(executable: &str) -> Option<String> {
    let version = |command: &mut std::process::Command| {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    };
    let arguments = ["--version".to_string()];
    let spawned = version(std::process::Command::new(executable).args(&arguments));
    // A shebang-less script (pnpm 12 without its native binary) runs under sh.
    #[cfg(unix)]
    let spawned = match spawned {
        Err(error) if error.raw_os_error() == Some(crate::run::process::ENOEXEC) => {
            match crate::run::process::sh_command(executable, &arguments, None, ".") {
                Some(mut command) => version(&mut command),
                None => Err(error),
            }
        }
        other => other,
    };
    let mut child = spawned.ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let mut output = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut output).ok()?;
    Some(js_trim(&output).to_string())
}

fn provisioned_manager(name: &str, version: &str) -> Option<ResolvedManager> {
    package_manager_roots().into_iter().find_map(|root| {
        let executable = Path::new(&root)
            .join(name)
            .join(version)
            .join("bin")
            .join(name);
        let executable = executable.to_string_lossy().into_owned();
        (executable_file(Path::new(&executable))
            && manager_version(&executable).as_deref() == Some(version))
        .then(|| ResolvedManager {
            executable,
            args_prefix: Vec::new(),
            resolved_version: version.to_string(),
        })
    })
}

fn provisioned_candidates(name: &str) -> Vec<ResolvedManager> {
    let mut candidates = Vec::new();
    for root in package_manager_roots() {
        let Ok(entries) = std::fs::read_dir(Path::new(&root).join(name)) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                candidates.extend(provisioned_manager(
                    name,
                    &entry.file_name().to_string_lossy(),
                ));
            }
        }
    }
    candidates
}

fn system_manager(name: &str, version: Option<&str>) -> Option<ResolvedManager> {
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
    for root in path
        .split(crate::platform::PATH_DELIMITER)
        .filter(|root| !root.is_empty())
    {
        let candidate = Path::new(root).join(name);
        if !executable_file(&candidate) {
            continue;
        }
        let Ok(executable) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        let executable = executable.to_string_lossy().into_owned();
        if executable
            .to_lowercase()
            .split('/')
            .any(|part| part == "corepack")
        {
            continue;
        }
        let Some(resolved) = manager_version(&executable) else {
            continue;
        };
        if resolved.is_empty() || version.is_some_and(|version| version != resolved) {
            continue;
        }
        return Some(ResolvedManager {
            executable,
            args_prefix: Vec::new(),
            resolved_version: resolved,
        });
    }
    None
}

fn bundled_manager(name: &str, version: Option<&str>) -> Option<ResolvedManager> {
    if !["npm", "pnpm", "yarn"].contains(&name) {
        return None;
    }
    bundled_package(name, name, version).or_else(|| {
        ["npm", "pnpm"]
            .contains(&name)
            .then(|| bundled_package(name, &format!("{name}-legacy"), version))
            .flatten()
    })
}

/// A manager package next to the TypeScript harness, run with Node (pnpm
/// 11 and later: its native binary).
fn bundled_package(name: &str, package: &str, version: Option<&str>) -> Option<ResolvedManager> {
    let modules = std::env::var("BLAME_HARNESS_NODE_MODULES")
        .ok()
        .filter(|modules| !modules.is_empty())?;
    let root: PathBuf = Path::new(&modules).join(package);
    let manifest = Json::parse(&String::from_utf8_lossy(
        &std::fs::read(root.join("package.json")).ok()?,
    ))
    .ok()?;
    let resolved = manifest.get("version").and_then(Json::as_str)?.to_string();
    if version.is_some_and(|version| version != resolved) {
        return None;
    }
    let entry = match manifest.get("bin") {
        Some(Json::Str(entry)) => entry.clone(),
        Some(bin) => bin.get(name).and_then(Json::as_str)?.to_string(),
        None => return None,
    };
    if name == "pnpm"
        && resolved
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .is_some_and(|major| major >= 11)
    {
        // pnpm 11+ ships its native binary as an optional dependency next to
        // the wrapper (`native-binary.mjs`); never the downloading wrapper.
        let platform = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let binary = if cfg!(windows) { "pnpm.exe" } else { "pnpm" };
        let parent = std::fs::canonicalize(&root).ok()?.parent()?.to_path_buf();
        let native = std::fs::canonicalize(
            parent
                .join("@pnpm")
                .join(format!("exe.{platform}-{arch}"))
                .join(binary),
        )
        .ok()?;
        return executable_file(&native).then(|| ResolvedManager {
            executable: native.to_string_lossy().into_owned(),
            args_prefix: Vec::new(),
            resolved_version: resolved,
        });
    }
    let node = stable_node()?;
    Some(ResolvedManager {
        executable: node,
        args_prefix: vec![root.join(entry).to_string_lossy().into_owned()],
        resolved_version: resolved,
    })
}

fn stable_node() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(configured) = std::env::var("BLAME_NODE_EXECUTABLE") {
        candidates.push(js_trim(&configured).to_string());
    }
    if cfg!(target_os = "linux") {
        candidates.extend(["/usr/bin/node".to_string(), "/bin/node".to_string()]);
    }
    if let Ok(path) = std::env::var("PATH") {
        // The TypeScript harness fell back on the Node it ran in; this one
        // is no Node, so on Windows it looks for the file PATH really holds.
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        candidates.extend(
            path.split(crate::platform::PATH_DELIMITER)
                .filter(|root| !root.is_empty())
                .map(|root| Path::new(root).join(node).to_string_lossy().into_owned()),
        );
    }
    let temporary = std::env::temp_dir().to_string_lossy().into_owned();
    candidates
        .into_iter()
        .filter(|candidate| !candidate.is_empty())
        .find_map(|candidate| {
            let path = Path::new(&candidate);
            if !executable_file(path) {
                return None;
            }
            let real = std::fs::canonicalize(path)
                .ok()?
                .to_string_lossy()
                .into_owned();
            (!(cfg!(target_os = "linux") && real.starts_with(&temporary))).then_some(real)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_manager_arguments() {
        assert_eq!(
            dependency_arguments("npm", "remove", &["left-pad@1.0.0".into()]),
            vec!["uninstall", "left-pad"]
        );
        assert_eq!(
            dependency_arguments("pnpm", "add", &["@scope/pkg".into()]),
            vec!["add", "@scope/pkg"]
        );
        let input = DependencyInput {
            action: "add".into(),
            packages: vec!["@prisma/adapter".into(), "zod".into()],
            package_path: None,
        };
        assert_eq!(
            aligned_packages(&input, br#"{"dependencies":{"prisma":"^5.2.0"}}"#),
            vec!["@prisma/adapter@5.2.0", "zod"]
        );
        assert!(
            resolve_package_manager("bun", Some("0.0.1"), false)
                .unwrap_err()
                .message
                .starts_with("PACKAGE_MANAGER_UNAVAILABLE:bun@0.0.1")
        );
    }
}
