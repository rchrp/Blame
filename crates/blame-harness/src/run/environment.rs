//! A workspace command's environment and shell (`environment-adapter.ts`,
//! `workspace-command-environment.ts`).

use crate::failure::{Failure, Outcome};
use crate::files::WorkspaceFiles;
use crate::json::Json;
use crate::text::js_trim;
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

pub type Environment = Vec<(String, String)>;

const PNPM_ONLY_NPM_CONFIGURATION: [&str; 6] = [
    "npm_config__jsr_registry",
    "npm_config_catalog",
    "npm_config_globalconfig",
    "npm_config_npm_globalconfig",
    "npm_config_overrides",
    "npm_config_verify_deps_before_run",
];

/// The harness's own environment, read when a command starts.
pub fn process_environment() -> Environment {
    std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn set(environment: &mut Environment, name: &str, value: String) {
    match environment.iter_mut().find(|(known, _)| known == name) {
        Some(slot) => slot.1 = value,
        None => environment.push((name.to_string(), value)),
    }
}

/// Without the harness's own variables: NODE_ENV, the Node test runner's
/// context, BLAME_*, and for npm the pnpm-only npm_config entries.
pub fn workspace_command_environment(
    environment: Environment,
    executable: Option<&str>,
) -> Environment {
    let npm = executable
        .is_some_and(|executable| crate::pathx::basename(executable).to_lowercase() == "npm");
    let mut filtered: Environment = environment
        .into_iter()
        .filter(|(name, _)| {
            name != "NODE_ENV"
                && name != "NODE_TEST_CONTEXT"
                && !name.starts_with("BLAME_")
                && !(npm && PNPM_ONLY_NPM_CONFIGURATION.contains(&name.to_lowercase().as_str()))
        })
        .collect();
    // pnpm 11+ reinstalls before `pnpm run`/`pnpm exec` when node_modules is
    // out of date: a command must not change dependencies (the dependency
    // operation does, journaled).
    if !filtered
        .iter()
        .any(|(name, _)| name.to_uppercase() == "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN")
    {
        filtered.push(("PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN".into(), "false".into()));
    }
    filtered
}

/// With credentials (a managed runtime request) a command never inherits a
/// GitHub token: GH_TOKEN is the granted one, if any.
pub fn with_command_credentials(
    environment: Environment,
    credentials: Option<&Json>,
) -> Environment {
    let Some(credentials) = credentials.filter(|credentials| credentials.is_object()) else {
        return environment;
    };
    let mut filtered: Environment = environment
        .into_iter()
        .filter(|(name, _)| !matches!(name.to_uppercase().as_str(), "GH_TOKEN" | "GITHUB_TOKEN"))
        .collect();
    if let Some(token) = credentials
        .get("githubToken")
        .and_then(Json::as_str)
        .filter(|token| !token.is_empty())
    {
        set(&mut filtered, "GH_TOKEN", token.to_string());
    }
    let Some(cli) = credentials.get("githubCli").filter(|cli| cli.is_object()) else {
        return filtered;
    };
    set(
        &mut filtered,
        "GH_CONFIG_DIR",
        cli.get("configDirectory")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
    );
    // The update notifiers write their state outside GH_CONFIG_DIR.
    set(&mut filtered, "GH_NO_UPDATE_NOTIFIER", "1".into());
    set(&mut filtered, "GH_NO_EXTENSION_UPDATE_NOTIFIER", "1".into());
    if let Some(bin) = cli
        .get("binDirectory")
        .and_then(Json::as_str)
        .filter(|bin| !bin.is_empty())
    {
        let key = path_key(&filtered);
        let current = filtered
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let entries: Vec<&str> = current
            .split(crate::platform::PATH_DELIMITER)
            .filter(|entry| !entry.is_empty() && *entry != bin)
            .collect();
        // First: the pinned gh runs even where the host has another one.
        set(
            &mut filtered,
            &key,
            std::iter::once(bin)
                .chain(entries)
                .collect::<Vec<_>>()
                .join(&crate::platform::PATH_DELIMITER.to_string()),
        );
    }
    filtered
}

fn path_key(environment: &Environment) -> String {
    environment
        .iter()
        .find(|(name, _)| name.to_uppercase() == "PATH")
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| "PATH".into())
}

fn path_entries(environment: &Environment) -> Vec<String> {
    let key = path_key(environment);
    environment
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| {
            value
                .split(crate::platform::PATH_DELIMITER)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// After any installed one, the ripgrep binary Blame ships (the TypeScript
/// harness's bundled `rg`; here the directory BLAME_HARNESS_RIPGREP_DIRECTORY
/// names): models reach for `rg` where the host has none.
pub fn with_bundled_tools(mut environment: Environment) -> Environment {
    let Some(directory) = std::env::var("BLAME_HARNESS_RIPGREP_DIRECTORY")
        .ok()
        .filter(|directory| !directory.is_empty())
    else {
        return environment;
    };
    let mut entries = path_entries(&environment);
    if entries.contains(&directory) {
        return environment;
    }
    entries.push(directory);
    let key = path_key(&environment);
    set(
        &mut environment,
        &key,
        entries.join(&crate::platform::PATH_DELIMITER.to_string()),
    );
    environment
}

static PIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(pnpm|yarn|npm)@(\d+\.\d+\.\d+)").expect("pattern"));

/// After any installed one, the package managers the runtime provisions
/// outside PATH; the version the nearest package.json pins wins, then one of
/// its major, then the newest.
pub fn with_provisioned_package_managers(mut environment: Environment, cwd: &str) -> Environment {
    let mut entries = path_entries(&environment);
    let pin = package_manager_pin(cwd);
    let mut added: Vec<String> = Vec::new();
    for name in ["pnpm", "yarn", "npm"] {
        if entries
            .iter()
            .any(|entry| Path::new(entry).join(name).exists())
        {
            continue;
        }
        let pinned = pin
            .as_ref()
            .filter(|(manager, _)| manager == name)
            .map(|(_, version)| version.as_str());
        if let Some(directory) = provisioned_directory(name, pinned)
            && !entries.contains(&directory)
        {
            added.push(directory);
        }
    }
    if added.is_empty() {
        return environment;
    }
    entries.extend(added);
    let key = path_key(&environment);
    set(
        &mut environment,
        &key,
        entries.join(&crate::platform::PATH_DELIMITER.to_string()),
    );
    environment
}

/// `BLAME_PACKAGE_MANAGER_ROOT`, then the VM's `/opt/blame/package-managers`.
pub fn package_manager_roots() -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for root in [
        std::env::var("BLAME_PACKAGE_MANAGER_ROOT")
            .ok()
            .map(|root| js_trim(&root).to_string()),
        Some("/opt/blame/package-managers".into()),
    ]
    .into_iter()
    .flatten()
    {
        if !root.is_empty() && !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn provisioned_directory(name: &str, pinned: Option<&str>) -> Option<String> {
    for root in package_manager_roots() {
        let Ok(entries) = std::fs::read_dir(Path::new(&root).join(name)) else {
            continue;
        };
        let versions: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|version| {
                Path::new(&root)
                    .join(name)
                    .join(version)
                    .join("bin")
                    .join(name)
                    .exists()
            })
            .collect();
        let major = pinned.and_then(|pinned| pinned.split('.').next());
        let chosen = pinned
            .and_then(|pinned| versions.iter().find(|version| *version == pinned).cloned())
            .or_else(|| {
                newest(
                    versions
                        .iter()
                        .filter(|version| major.is_some() && version.split('.').next() == major)
                        .cloned()
                        .collect(),
                )
            })
            .or_else(|| newest(versions.clone()));
        if let Some(chosen) = chosen {
            return Some(
                Path::new(&root)
                    .join(name)
                    .join(chosen)
                    .join("bin")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    None
}

/// The greatest version, numerically (`localeCompare` with `numeric`).
pub fn newest(mut versions: Vec<String>) -> Option<String> {
    versions.sort_by(|left, right| numeric_compare(right, left));
    versions.into_iter().next()
}

/// Digit runs compare as numbers, the rest as text.
pub fn numeric_compare(left: &str, right: &str) -> std::cmp::Ordering {
    fn parts(value: &str) -> Vec<(bool, String)> {
        let mut parts: Vec<(bool, String)> = Vec::new();
        for character in value.chars() {
            let digit = character.is_ascii_digit();
            match parts.last_mut() {
                Some((kind, text)) if *kind == digit => text.push(character),
                _ => parts.push((digit, character.to_string())),
            }
        }
        parts
    }
    let (left, right) = (parts(left), parts(right));
    for (a, b) in left.iter().zip(right.iter()) {
        let ordering = if a.0 && b.0 {
            a.1.trim_start_matches('0')
                .len()
                .cmp(&b.1.trim_start_matches('0').len())
                .then_with(|| a.1.trim_start_matches('0').cmp(b.1.trim_start_matches('0')))
        } else {
            crate::text::locale_compare(&a.1, &b.1)
        };
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn package_manager_pin(cwd: &str) -> Option<(String, String)> {
    let mut directory = Path::new(cwd).to_path_buf();
    loop {
        if let Ok(content) = std::fs::read(directory.join("package.json"))
            && let Ok(manifest) = Json::parse(&String::from_utf8_lossy(&content))
            && let Some(captures) = manifest
                .get("packageManager")
                .and_then(Json::as_str)
                .and_then(|value| PIN.captures(value))
        {
            return Some((captures[1].to_string(), captures[2].to_string()));
        }
        if !directory.pop() {
            return None;
        }
    }
}

/// The whole environment of a command started in `cwd`.
pub fn command_environment(
    extra: &[(String, String)],
    credentials: Option<&Json>,
    executable: &str,
    cwd: &str,
) -> Environment {
    let mut environment = process_environment();
    for (name, value) in extra {
        set(&mut environment, name, value.clone());
    }
    let environment = with_command_credentials(environment, credentials);
    with_provisioned_package_managers(
        with_bundled_tools(workspace_command_environment(environment, Some(executable))),
        cwd,
    )
}

/// The shell a literal command runs in: bash with pipefail, its profile
/// loaded. A login profile can put directories before the inherited PATH
/// (path_helper, `brew shellenv`): one that must come first goes back first,
/// on the command's own line so line numbers stay the command's. On Windows
/// cmd.exe takes the command line as it is (`/d /s /c`).
pub fn shell_command(command: &str, first_path_directory: Option<&str>) -> (String, Vec<String>) {
    if cfg!(windows) {
        return (
            "cmd.exe".into(),
            vec!["/d".into(), "/s".into(), "/c".into(), command.to_string()],
        );
    }
    let script = match first_path_directory {
        Some(directory) => format!(
            "PATH='{}':\"$PATH\"; {command}",
            directory.replace('\'', "'\\''")
        ),
        None => command.to_string(),
    };
    (
        "/bin/bash".into(),
        vec!["-o".into(), "pipefail".into(), "-lc".into(), script],
    )
}

/// The absolute directory of a workspace-relative cwd.
pub fn command_cwd(files: &WorkspaceFiles, path: Option<&str>) -> Outcome<String> {
    let normalized = files.normalize_path(path.unwrap_or("."))?;
    let profile = files.path_profile(&normalized)?;
    if !profile.directory {
        return Err(Failure::new(format!("{normalized} is not a directory.")));
    }
    Ok(crate::pathx::resolve(&files.root, &normalized))
}

pub fn target() -> &'static str {
    if cfg!(windows) {
        "windows-native"
    } else if cfg!(target_os = "macos") {
        "macos-native"
    } else {
        "linux-native"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_and_grants() {
        let base: Environment = vec![
            ("GH_TOKEN".into(), "x".into()),
            ("github_token".into(), "y".into()),
            ("PATH".into(), "/bin".into()),
            ("BLAME_Z".into(), "1".into()),
        ];
        let granted = with_command_credentials(base.clone(), Some(&Json::obj()));
        assert_eq!(
            granted,
            vec![
                ("PATH".to_string(), "/bin".to_string()),
                ("BLAME_Z".to_string(), "1".to_string())
            ]
        );
        let filtered = workspace_command_environment(base, Some("npm"));
        assert!(!filtered.iter().any(|(name, _)| name == "BLAME_Z"));
        assert_eq!(
            newest(vec!["9.1.0".into(), "10.0.1".into()]),
            Some("10.0.1".into())
        );
    }
}
