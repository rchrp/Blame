//! Command output as results show it (`light-diagnostic.ts`,
//! `validation-output.ts`, `validation-scope.ts`).

use crate::json::Json;
use crate::obj;
use crate::text::{utf16_len, utf16_prefix};
use std::fs;
use std::path::Path;

/// The last `units` UTF-16 units of `value` (`value.slice(-units)`).
pub fn utf16_suffix(value: &str, units: usize) -> &str {
    let total = utf16_len(value);
    if units >= total {
        return value;
    }
    let skip = total - units;
    let mut used = 0;
    for (index, character) in value.char_indices() {
        if used >= skip {
            return &value[index..];
        }
        used += character.len_utf16();
    }
    ""
}

/// Long output keeps its start and its end around a marker.
pub fn bounded_diagnostic(value: &str, fallback: &str, maximum: usize) -> String {
    if value.is_empty() {
        return fallback.to_string();
    }
    if utf16_len(value) <= maximum {
        return value.to_string();
    }
    let half = (maximum - 32) / 2;
    format!(
        "{}\n… diagnostic truncated …\n{}",
        utf16_prefix(value, half),
        utf16_suffix(value, half)
    )
}

pub fn diagnostic(value: &str) -> String {
    bounded_diagnostic(value, "", 16_000)
}

/// A long validation output goes to `.blame/logs`, the result keeps 900 characters.
pub fn validation_output(root: &str, output: &str) -> Json {
    if utf16_len(output) <= 1_200 {
        return obj! { "output" => output };
    }
    let written = (|| -> std::io::Result<String> {
        let mut directory = Path::new(root).to_path_buf();
        for segment in [".blame", "logs"] {
            directory = directory.join(segment);
            match fs::create_dir(&directory) {
                Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
                    return Err(error);
                }
                _ => {}
            }
            let metadata = fs::symlink_metadata(&directory)?;
            if !metadata.is_dir() {
                return Err(std::io::Error::other(
                    "Validation log directory is not a regular directory.",
                ));
            }
        }
        let name = format!("validation-{}.log", uuid());
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        crate::platform::private_file(&mut options);
        std::io::Write::write_all(&mut options.open(directory.join(&name))?, output.as_bytes())?;
        Ok(name)
    })();
    match written {
        Ok(name) => {
            obj! { "output" => bounded_diagnostic(output, "", 900), "outputLog" => format!(".blame/logs/{name}") }
        }
        Err(_) => obj! { "output" => bounded_diagnostic(output, "", 4_000) },
    }
}

/// A random version-4 UUID, as `crypto.randomUUID()` writes it.
pub fn uuid() -> String {
    let seed = crate::identity::sha256_hex(
        format!(
            "{:?}{}{:?}",
            std::time::SystemTime::now(),
            std::process::id(),
            std::thread::current().id()
        )
        .as_bytes(),
    );
    let mut hex: Vec<char> = seed.chars().take(32).collect();
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][(hex[16].to_digit(16).unwrap_or(0) % 4) as usize];
    let hex: String = hex.into_iter().collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

const VALIDATION_MANIFESTS: [&str; 8] = [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "pytest.ini",
];

fn dirname(path: &str) -> &str {
    path.rfind('/')
        .map_or(".", |index| if index == 0 { "/" } else { &path[..index] })
}

/// The changed paths a validation in `cwd` covers: those its package owns.
pub fn validation_scope_paths(paths: &[String], files: &[String], cwd: &str) -> Vec<String> {
    let mut packages: Vec<&str> = files
        .iter()
        .filter(|path| {
            VALIDATION_MANIFESTS.contains(&crate::pathx::basename(path))
                || path.ends_with(".csproj")
        })
        .map(|path| dirname(path))
        .collect();
    packages.sort_by_key(|directory| std::cmp::Reverse(utf16_len(directory)));
    paths
        .iter()
        .filter(|path| {
            let owner = packages
                .iter()
                .find(|directory| **directory == "." || path.starts_with(&format!("{directory}/")))
                .copied()
                .unwrap_or(".");
            owner == cwd
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_long_output() {
        let long = "x".repeat(100);
        let bounded = bounded_diagnostic(&long, "", 40);
        assert_eq!(
            bounded,
            format!(
                "{}\n… diagnostic truncated …\n{}",
                "x".repeat(4),
                "x".repeat(4)
            )
        );
        assert_eq!(utf16_suffix("abcdef", 2), "ef");
        assert_eq!(uuid().len(), 36);
    }

    #[test]
    fn scopes_paths_to_their_package() {
        let files = vec!["package.json".to_string(), "web/package.json".to_string()];
        let paths = vec!["src/a.ts".to_string(), "web/b.ts".to_string()];
        assert_eq!(validation_scope_paths(&paths, &files, "web"), ["web/b.ts"]);
        assert_eq!(validation_scope_paths(&paths, &files, "."), ["src/a.ts"]);
    }
}
