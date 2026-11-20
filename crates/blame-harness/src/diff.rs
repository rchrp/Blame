//! jsdiff 9's `diffLines`, step for step: its Myers search explores
//! diagonals in the same order and breaks ties the same way, so the parts,
//! and the edit ranges `edit_code` derives from them, are those the
//! TypeScript harness computes.

#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub value: String,
    pub added: bool,
    pub removed: bool,
    pub count: usize,
}

struct Component {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<usize>,
}

#[derive(Clone, Copy)]
struct Path {
    old_pos: i64,
    last: Option<usize>,
}

/// Lines with their newline (`\n` or `\r\n`), empty tokens dropped.
fn tokenize(value: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            lines.push(&value[start..=index]);
            start = index + 1;
        }
        index += 1;
    }
    if start < value.len() {
        lines.push(&value[start..]);
    }
    lines.retain(|line| !line.is_empty());
    lines
}

pub fn diff_lines(old: &str, new: &str) -> Vec<Part> {
    let old_tokens = tokenize(old);
    let new_tokens = tokenize(new);
    let (old_len, new_len) = (old_tokens.len() as i64, new_tokens.len() as i64);
    let mut arena: Vec<Component> = Vec::new();
    let max_edit_length = new_len + old_len;
    // Diagonals run from -max to +max; offset them into a vector.
    let offset = max_edit_length + 1;
    let mut best: Vec<Option<Path>> = vec![None; (2 * offset + 1) as usize];
    let slot = |diagonal: i64| (diagonal + offset) as usize;

    let extract_common = |arena: &mut Vec<Component>, path: &mut Path, diagonal: i64| -> i64 {
        let mut old_pos = path.old_pos;
        let mut new_pos = old_pos - diagonal;
        let mut common = 0;
        while new_pos + 1 < new_len
            && old_pos + 1 < old_len
            && old_tokens[(old_pos + 1) as usize] == new_tokens[(new_pos + 1) as usize]
        {
            new_pos += 1;
            old_pos += 1;
            common += 1;
        }
        if common > 0 {
            arena.push(Component {
                count: common,
                added: false,
                removed: false,
                previous: path.last,
            });
            path.last = Some(arena.len() - 1);
        }
        path.old_pos = old_pos;
        new_pos
    };

    let mut first = Path {
        old_pos: -1,
        last: None,
    };
    let new_pos = extract_common(&mut arena, &mut first, 0);
    if first.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        return build_values(&arena, first.last, &new_tokens, &old_tokens);
    }
    best[slot(0)] = Some(first);
    let (mut min_diagonal, mut max_diagonal) = (i64::MIN, i64::MAX);
    let mut edit_length: i64 = 1;
    while edit_length <= max_edit_length {
        let mut diagonal = min_diagonal.max(-edit_length);
        while diagonal <= max_diagonal.min(edit_length) {
            let remove_path = if diagonal > -offset {
                best[slot(diagonal - 1)]
            } else {
                None
            };
            let add_path = if diagonal < offset {
                best[slot(diagonal + 1)]
            } else {
                None
            };
            if remove_path.is_some() {
                best[slot(diagonal - 1)] = None;
            }
            let can_add = add_path.is_some_and(|path| {
                let add_new_pos = path.old_pos - diagonal;
                0 <= add_new_pos && add_new_pos < new_len
            });
            let can_remove = remove_path.is_some_and(|path| path.old_pos + 1 < old_len);
            if !can_add && !can_remove {
                best[slot(diagonal)] = None;
                diagonal += 2;
                continue;
            }
            let mut base = if !can_remove
                || (can_add && remove_path.unwrap().old_pos < add_path.unwrap().old_pos)
            {
                add_to_path(&mut arena, add_path.unwrap(), true, false, 0)
            } else {
                add_to_path(&mut arena, remove_path.unwrap(), false, true, 1)
            };
            let new_pos = extract_common(&mut arena, &mut base, diagonal);
            if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                return build_values(&arena, base.last, &new_tokens, &old_tokens);
            }
            best[slot(diagonal)] = Some(base);
            if base.old_pos + 1 >= old_len {
                max_diagonal = max_diagonal.min(diagonal - 1);
            }
            if new_pos + 1 >= new_len {
                min_diagonal = min_diagonal.max(diagonal + 1);
            }
            diagonal += 2;
        }
        edit_length += 1;
    }
    // Unreachable without a maximum edit length or a timeout.
    Vec::new()
}

fn add_to_path(
    arena: &mut Vec<Component>,
    path: Path,
    added: bool,
    removed: bool,
    old_increment: i64,
) -> Path {
    let component = match path.last.map(|index| &arena[index]) {
        Some(last) if last.added == added && last.removed == removed => Component {
            count: last.count + 1,
            added,
            removed,
            previous: last.previous,
        },
        _ => Component {
            count: 1,
            added,
            removed,
            previous: path.last,
        },
    };
    arena.push(component);
    Path {
        old_pos: path.old_pos + old_increment,
        last: Some(arena.len() - 1),
    }
}

fn build_values(
    arena: &[Component],
    last: Option<usize>,
    new_tokens: &[&str],
    old_tokens: &[&str],
) -> Vec<Part> {
    let mut chain = Vec::new();
    let mut cursor = last;
    while let Some(index) = cursor {
        chain.push(index);
        cursor = arena[index].previous;
    }
    chain.reverse();
    let (mut new_pos, mut old_pos) = (0usize, 0usize);
    chain
        .into_iter()
        .map(|index| {
            let component = &arena[index];
            let value = if component.removed {
                let value = old_tokens[old_pos..old_pos + component.count].concat();
                old_pos += component.count;
                value
            } else {
                let value = new_tokens[new_pos..new_pos + component.count].concat();
                new_pos += component.count;
                if !component.added {
                    old_pos += component.count;
                }
                value
            };
            Part {
                value,
                added: component.added,
                removed: component.removed,
                count: component.count,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_empty_and_equal_inputs() {
        assert_eq!(
            diff_lines("", "a\n"),
            [Part {
                value: "a\n".into(),
                added: true,
                removed: false,
                count: 1
            }]
        );
        assert_eq!(
            diff_lines("same\n", "same\n"),
            [Part {
                value: "same\n".into(),
                added: false,
                removed: false,
                count: 1
            }]
        );
    }
}
