//! Node's `path.posix` resolution: lexical, never touching the disk.
//!
//! Workspace paths are checked against the root by spelling first (as the
//! TypeScript harness does), then by real path where it matters.

/// `path.resolve(base, path)`: absolute, normalised, without a trailing slash.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{base}/{path}")
    };
    normalize_absolute(&joined)
}

fn normalize_absolute(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `path.relative(from, to)` for absolute normalised paths.
pub fn relative(from: &str, to: &str) -> String {
    let from_parts: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').filter(|part| !part.is_empty()).collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut output: Vec<&str> = vec![".."; from_parts.len() - common];
    output.extend(&to_parts[common..]);
    output.join("/")
}

/// `local === ".." || local.startsWith("../") || isAbsolute(local)`.
pub fn escapes(local: &str) -> bool {
    local == ".." || local.starts_with("../") || local.starts_with('/')
}

/// `path.posix.basename`.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `path.extname(path).toLowerCase()`.
pub fn extname_lower(path: &str) -> String {
    let base = basename(path);
    match base.rfind('.') {
        Some(index) if index > 0 => base[index..].to_lowercase(),
        _ => String::new(),
    }
}

/// `path.toLowerCase().match(/\.[^.]+$/u)?.[0] ?? ""`: the last dot of the
/// whole path, unlike `extname` (a dot in a directory name counts).
pub fn dotted_suffix_lower(path: &str) -> String {
    let lower = path.to_lowercase();
    match lower.rfind('.') {
        Some(index) if index + 1 < lower.len() => lower[index..].to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        assert_eq!(resolve("/a/b", "../c/./d/"), "/a/c/d");
        assert_eq!(resolve("/a", "/x/../y"), "/y");
        assert_eq!(relative("/a/b", "/a/b"), "");
        assert_eq!(relative("/a/b", "/a/c/d"), "../c/d");
        assert_eq!(relative("/a/b", "/a/b/c"), "c");
        assert_eq!(dotted_suffix_lower("src.d/File.TS"), ".ts");
        assert_eq!(dotted_suffix_lower("Makefile"), "");
        assert_eq!(extname_lower(".env"), "");
    }
}
