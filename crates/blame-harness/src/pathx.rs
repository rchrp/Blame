//! Node's `path.posix` resolution: lexical, never touching the disk.
//!
//! Workspace paths are checked against the root by spelling first (as the
//! TypeScript harness does), then by real path where it matters.

/// An absolute path's root and the rest, `/`-separated. On Unix the root is
/// `/`; on Windows a drive (`C:/`), with backslashes and the `\\?\` prefix
/// of canonical paths read as `/`, as Windows itself accepts them.
fn split_root(path: &str) -> Option<(String, String)> {
    if cfg!(windows) {
        let portable = path.replace('\\', "/");
        let portable = portable.strip_prefix("//?/").unwrap_or(&portable);
        let bytes = portable.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let rest = &portable[2..];
            return rest.starts_with('/').then(|| {
                (
                    format!("{}:/", bytes[0].to_ascii_uppercase() as char),
                    rest.to_string(),
                )
            });
        }
        return portable
            .starts_with('/')
            .then(|| ("/".to_string(), portable.to_string()));
    }
    path.starts_with('/')
        .then(|| ("/".to_string(), path.to_string()))
}

/// `path.isAbsolute`.
pub fn is_absolute(path: &str) -> bool {
    split_root(path).is_some()
}

/// `path.resolve(base, path)`: absolute, normalised, without a trailing slash.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if is_absolute(path) {
        path.to_string()
    } else {
        format!("{base}/{path}")
    };
    normalize_absolute(&joined)
}

fn normalize_absolute(path: &str) -> String {
    let (root, rest) = split_root(path).unwrap_or_else(|| ("/".into(), path.replace('\\', "/")));
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("{root}{}", parts.join("/"))
}

/// `path.relative(from, to)` for absolute normalised paths; another
/// Windows drive gives `to` itself, as Node does.
pub fn relative(from: &str, to: &str) -> String {
    let (from_root, from) = split_root(from).unwrap_or(("/".into(), from.to_string()));
    let (to_root, to_rest) = split_root(to).unwrap_or(("/".into(), to.to_string()));
    if from_root != to_root {
        return normalize_absolute(to);
    }
    let from_parts: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let to_parts: Vec<&str> = to_rest.split('/').filter(|part| !part.is_empty()).collect();
    let same = |left: &&str, right: &&str| {
        if cfg!(windows) {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| same(left, right))
        .count();
    let mut output: Vec<&str> = vec![".."; from_parts.len() - common];
    output.extend(&to_parts[common..]);
    output.join("/")
}

/// `local === ".." || local.startsWith("../") || isAbsolute(local)`.
pub fn escapes(local: &str) -> bool {
    local == ".." || local.starts_with("../") || is_absolute(local)
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
