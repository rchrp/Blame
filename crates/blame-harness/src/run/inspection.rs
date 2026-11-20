//! Read-only shell inspections answered by search_code and read_code
//! instead of the shell (`shell-inspection.ts`), so their observations carry
//! aliases, read coverage and line numbers; and the classification of a
//! command that only reads the workspace.

use super::shell_words::{ShellCommand, ShellWord, literal_shell_statements, shell_command_names};
use crate::json::Json;
use crate::lexical::{escape_regex, literal_braces};
use crate::obj;
use regex::Regex;
use std::sync::LazyLock;

/// A routed inspection: the statement and the tool input that answers it.
#[derive(Clone, Debug)]
pub enum Route {
    Search {
        command: String,
        request: Json,
        presented_whole: bool,
    },
    Read {
        command: String,
        input: Json,
        listing: bool,
        tail_lines: Option<usize>,
    },
}

const ROUTED_MATCH_LIMIT: usize = 50;
const ROUTED_FILE_LIMIT: usize = 100;
const MAXIMUM_CONTEXT: usize = 30;
const IGNORABLE_DIRECTORIES: [&str; 8] = [
    ".git",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
];
const READ_ONLY_COMMANDS: [&str; 29] = [
    "basename", "cat", "cd", "cut", "dirname", "du", "echo", "egrep", "fgrep", "file", "find",
    "grep", "head", "ls", "nl", "printf", "pwd", "realpath", "rg", "sed", "sort", "stat", "tail",
    "test", "tr", "true", "uniq", "wc", "which",
];

fn ripgrep_type(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "css" => &["*.css"],
        "go" => &["*.go"],
        "html" => &["*.html", "*.htm"],
        "java" => &["*.java"],
        "js" => &["*.js", "*.jsx", "*.mjs", "*.cjs"],
        "json" => &["*.json"],
        "markdown" | "md" => &["*.md", "*.markdown"],
        "py" => &["*.py"],
        "rust" => &["*.rs"],
        "sh" => &["*.sh"],
        "ts" => &["*.ts", "*.tsx", "*.mts", "*.cts"],
        "yaml" => &["*.yaml", "*.yml"],
        _ => return None,
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Flavor {
    Basic,
    Extended,
    Fixed,
    Perl,
    Rust,
}

struct Plan {
    after: usize,
    before: usize,
    flavor: Flavor,
    globs: Vec<String>,
    ignore_case: Option<bool>,
    files_output: bool,
    paths: Vec<ShellWord>,
    patterns: Vec<String>,
    smart_case: bool,
    word: bool,
}

impl Plan {
    fn new(flavor: Flavor) -> Plan {
        Plan {
            after: 0,
            before: 0,
            flavor,
            globs: Vec::new(),
            ignore_case: None,
            files_output: false,
            paths: Vec::new(),
            patterns: Vec::new(),
            smart_case: false,
            word: false,
        }
    }
}

#[derive(Default)]
struct Filters {
    /// `grep -v` patterns: `{ source, ignoreCase }`.
    exclude: Vec<Json>,
    head: Option<usize>,
}

/// Routes for `cd`, grep, rg, cat, head, tail and `sed -n`, with `| grep -v`,
/// `| head` and stderr redirections; none when the shell could behave
/// differently, so the command runs.
pub fn shell_inspection_routes(command: &str, cwd: Option<&str>, root: &str) -> Option<Vec<Route>> {
    let statements = literal_shell_statements(command)?;
    let mut directory = workspace_path(root, ".", cwd.unwrap_or("."))?;
    let mut routes: Vec<Route> = Vec::new();
    for statement in statements {
        let (first, rest) = statement.pipeline.split_first()?;
        if first.words.first().map(|word| word.value.as_str()) == Some("cd")
            && rest.is_empty()
            && routes.is_empty()
        {
            directory = if first.words.len() == 2 {
                workspace_path(root, &directory, &first.words[1].value)?
            } else {
                return None;
            };
            continue;
        }
        let filters = pipeline_filters(rest)?;
        routes.push(inspection_route(
            first,
            &filters,
            root,
            &directory,
            &statement.text,
        )?);
    }
    (!routes.is_empty() && routes.len() <= 4).then_some(routes)
}

pub const ROUTED_GUIDANCE: &str = "Answered by search_code/read_code instead of the shell: results carry sN aliases, read coverage and line numbers. Call those tools directly for source inspection.";

/// Presents routed answers; none when any of them needs the shell after all.
pub fn answer(
    command: &str,
    routes: &[Route],
    mut search: impl FnMut(&Json) -> crate::failure::Outcome<Json>,
    mut read: impl FnMut(&Json) -> crate::failure::Outcome<Json>,
    mut line_count: impl FnMut(&str) -> crate::failure::Outcome<usize>,
) -> crate::failure::Outcome<Option<Json>> {
    let mut answers: Vec<Json> = Vec::new();
    for route in routes {
        let (result, tool, listing, text) = match route {
            Route::Search {
                command, request, ..
            } => (search(request)?, "search_code", false, command),
            Route::Read {
                command,
                input,
                listing,
                tail_lines,
            } => {
                let input = match tail_lines {
                    Some(lines) => {
                        let target = input.get("target").and_then(Json::as_str).unwrap_or("");
                        let total = line_count(target)?;
                        obj! { "target" => target, "range" => obj! { "startLine" => 1.max((total + 1).saturating_sub(*lines)), "endLine" => total.max(1) } }
                    }
                    None => input.clone(),
                };
                (read(&input)?, "read_code", *listing, command)
            }
        };
        let ok = result.get("status").and_then(Json::as_str) == Some("ok");
        let data = if ok {
            result
                .get("data")
                .filter(|data| data.is_object())
                .cloned()
                .unwrap_or(Json::obj())
        } else {
            Json::obj()
        };
        let directory = data.get("view").and_then(Json::as_str) == Some("directory");
        if !ok
            || data.get("scopeStatus").and_then(Json::as_str) == Some("empty")
            || directory != listing
        {
            return Ok(None);
        }
        let mut data = data;
        // A grep filter or one-sided context cannot be a search_code call.
        if let Route::Search {
            presented_whole: false,
            ..
        } = route
        {
            data.remove("nextSearch");
        }
        let mut entry = obj! { "command" => text.as_str(), "servedBy" => tool };
        entry.extend(data);
        if let Some(receipt) = result
            .get("receipt")
            .filter(|receipt| !matches!(receipt, Json::Null))
        {
            entry.set("receipt", receipt.clone());
        }
        answers.push(entry);
    }
    let data = if answers.len() == 1 {
        let mut single = answers.remove(0);
        single.set("command", command);
        single.set("guidance", ROUTED_GUIDANCE);
        single
    } else {
        obj! { "command" => command, "answers" => Json::Arr(answers), "guidance" => ROUTED_GUIDANCE }
    };
    Ok(Some(obj! { "status" => "ok", "data" => data }))
}

static SED_INPLACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)sed(?-u:\b)[^|;&]*\s-[a-zA-Z]*i").expect("pattern"));
static FIND_ACTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s-(?:exec|execdir|delete|ok|fprint)(?-u:\b)").expect("pattern"));
static HARMLESS_REDIRECTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"2>&1|2>\s*/dev/null").expect("pattern"));

/// "search" for grep or rg (exit 1 means nothing matched), "read" for other
/// reads, none for anything that may write or run code.
pub fn read_only_inspection(command: &str) -> Option<&'static str> {
    let names = shell_command_names(command)?;
    if names.is_empty()
        || !names
            .iter()
            .all(|name| READ_ONLY_COMMANDS.contains(&name.as_str()))
    {
        return None;
    }
    if writes_through_redirection(&HARMLESS_REDIRECTS.replace_all(command, "")) {
        return None;
    }
    if names.iter().any(|name| name == "sed") && SED_INPLACE.is_match(command) {
        return None;
    }
    if names.iter().any(|name| name == "find") && FIND_ACTION.is_match(command) {
        return None;
    }
    Some(
        if names
            .iter()
            .any(|name| ["egrep", "fgrep", "grep", "rg"].contains(&name.as_str()))
        {
            "search"
        } else {
            "read"
        },
    )
}

/// `/(?:^|[^\w&>-])>{1,2}\s*(?!\/dev\/null\b|&\d)/u`, backtracking included:
/// a `>` run not followed at once by `/dev/null` or `&N` writes somewhere.
fn writes_through_redirection(command: &str) -> bool {
    let characters: Vec<char> = command.chars().collect();
    let harmless_at = |index: usize| {
        let rest: String = characters[index.min(characters.len())..].iter().collect();
        if let Some(after) = rest.strip_prefix("/dev/null") {
            return !after
                .chars()
                .next()
                .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_');
        }
        let mut chars = rest.chars();
        chars.next() == Some('&') && chars.next().is_some_and(|next| next.is_ascii_digit())
    };
    for (index, character) in characters.iter().enumerate() {
        if *character != '>' {
            continue;
        }
        let preceded = index == 0 || {
            let previous = characters[index - 1];
            !(previous.is_ascii_alphanumeric()
                || previous == '_'
                || previous == '&'
                || previous == '>'
                || previous == '-')
        };
        if !preceded {
            continue;
        }
        let run = characters[index..]
            .iter()
            .take(2)
            .take_while(|next| **next == '>')
            .count();
        for count in (1..=run).rev() {
            let spaces = characters[index + count..]
                .iter()
                .take_while(|next| next.is_whitespace())
                .count();
            if (0..=spaces).any(|space| !harmless_at(index + count + space)) {
                return true;
            }
        }
    }
    false
}

fn pipeline_filters(commands: &[ShellCommand]) -> Option<Filters> {
    let mut filters = Filters::default();
    for (index, command) in commands.iter().enumerate() {
        let name = command.words.first().map(|word| word.value.as_str());
        if name == Some("head") && index == commands.len() - 1 {
            filters.head = Some(head_count(&command.words[1..])?);
        } else if name == Some("grep") || name == Some("egrep") {
            filters.exclude.push(exclude_filter(&command.words)?);
        } else {
            return None;
        }
    }
    Some(filters)
}

static SHORT_FLAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-[a-zA-Z]+$").expect("pattern"));

/// `grep -v PATTERN` applied to a previous command's output lines.
fn exclude_filter(words: &[ShellWord]) -> Option<Json> {
    let (mut inverted, mut ignore_case) = (false, false);
    let mut flavor = if words.first().map(|word| word.value.as_str()) == Some("egrep") {
        Flavor::Extended
    } else {
        Flavor::Basic
    };
    let mut operands: Vec<&ShellWord> = Vec::new();
    for word in &words[1..] {
        if SHORT_FLAGS.is_match(&word.value) {
            for flag in word.value[1..].chars() {
                match flag {
                    'v' => inverted = true,
                    'i' => ignore_case = true,
                    'E' => flavor = Flavor::Extended,
                    'F' => flavor = Flavor::Fixed,
                    _ => return None,
                }
            }
        } else {
            operands.push(word);
        }
    }
    let pattern = (operands.len() == 1 && !operands[0].glob).then(|| operands[0].value.clone())?;
    if !inverted {
        return None;
    }
    let source = rust_pattern(&pattern, flavor)?;
    regex::RegexBuilder::new(&source)
        .case_insensitive(ignore_case)
        .build()
        .ok()?;
    Some(obj! { "source" => source, "ignoreCase" => ignore_case })
}

fn inspection_route(
    command: &ShellCommand,
    filters: &Filters,
    root: &str,
    directory: &str,
    text: &str,
) -> Option<Route> {
    let name = command.words.first().map(|word| word.value.as_str());
    let plan = match name {
        Some("grep" | "egrep" | "fgrep") => grep_plan(&command.words),
        Some("rg") => ripgrep_plan(&command.words),
        _ => None,
    };
    if let Some(plan) = plan {
        return search_route(plan, filters, root, directory, text);
    }
    if !filters.exclude.is_empty() {
        return None;
    }
    let (input, listing, tail_lines) =
        read_input(name?, &command.words[1..], filters.head, root, directory)?;
    Some(Route::Read {
        command: text.to_string(),
        input,
        listing,
        tail_lines,
    })
}

static UPPERCASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Lu}").expect("pattern"));

fn search_route(
    plan: Plan,
    filters: &Filters,
    root: &str,
    directory: &str,
    text: &str,
) -> Option<Route> {
    let patterns: Vec<String> = plan
        .patterns
        .iter()
        .map(|pattern| rust_pattern(pattern, plan.flavor))
        .collect::<Option<Vec<_>>>()?;
    if patterns.is_empty() || patterns.iter().any(String::is_empty) {
        return None;
    }
    let joined = if patterns.len() == 1 {
        patterns[0].clone()
    } else {
        patterns
            .iter()
            .map(|pattern| format!("(?:{pattern})"))
            .collect::<Vec<_>>()
            .join("|")
    };
    let query = if plan.word {
        format!("\\b(?:{joined})\\b")
    } else {
        joined
    };
    let paths: Vec<ShellWord> = plan
        .paths
        .iter()
        .map(|path| {
            workspace_path(root, directory, &path.value).map(|value| ShellWord {
                glob: path.glob,
                value,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let scope = search_scopes(&paths, &plan.globs);
    let case_sensitive = if plan.smart_case {
        UPPERCASE.is_match(&plan.patterns.join(""))
    } else {
        plan.ignore_case != Some(true)
    };
    let limit = filters
        .head
        .unwrap_or(if plan.files_output {
            ROUTED_FILE_LIMIT
        } else {
            ROUTED_MATCH_LIMIT
        })
        .min(100);
    let mut request = obj! {
        "query" => query,
        "mode" => "regex",
        "scope" => Json::Arr(scope.into_iter().map(Json::from).collect()),
        "caseSensitive" => case_sensitive,
        "limit" => limit,
    }
    .with_opt("output", plan.files_output.then_some("files"));
    if plan.before > 0 || plan.after > 0 {
        request.set("contextBefore", plan.before);
        request.set("contextAfter", plan.after);
    }
    if !filters.exclude.is_empty() {
        request.set("excludeLines", Json::Arr(filters.exclude.clone()));
    }
    let presented_whole = filters.exclude.is_empty() && plan.before == plan.after;
    Some(Route::Search {
        command: text.to_string(),
        request,
        presented_whole,
    })
}

fn split_long_option(value: &str) -> (String, Option<String>) {
    match value.find('=') {
        Some(separator) => (
            value[..separator].to_string(),
            Some(value[separator + 1..].to_string()),
        ),
        None => (value.to_string(), None),
    }
}

fn set_context(plan: &mut Plan, flag: char, value: Option<&str>) -> bool {
    let Some(lines) = value
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<usize>().ok())
    else {
        return false;
    };
    let lines = lines.min(MAXIMUM_CONTEXT);
    if flag == 'A' || flag == 'C' {
        plan.after = lines;
    }
    if flag == 'B' || flag == 'C' {
        plan.before = lines;
    }
    true
}

fn grep_plan(words: &[ShellWord]) -> Option<Plan> {
    let name = words[0].value.as_str();
    let mut plan = Plan::new(match name {
        "egrep" => Flavor::Extended,
        "fgrep" => Flavor::Fixed,
        _ => Flavor::Basic,
    });
    let (mut recursive, mut operands_only) = (false, false);
    let mut operands: Vec<ShellWord> = Vec::new();
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        let value = word.value.as_str();
        if operands_only || !value.starts_with('-') || value == "-" {
            operands.push(word.clone());
            index += 1;
            continue;
        }
        if value == "--" {
            operands_only = true;
            index += 1;
            continue;
        }
        if value.starts_with("--") {
            let (option, inline) = split_long_option(value);
            let mut argument = || {
                inline.clone().or_else(|| {
                    index += 1;
                    words.get(index).map(|word| word.value.clone())
                })
            };
            match option.as_str() {
                "--include" => plan.globs.push(argument().filter(|glob| !glob.is_empty())?),
                "--exclude-dir" => {
                    if !IGNORABLE_DIRECTORIES.contains(&argument().unwrap_or_default().as_str()) {
                        return None;
                    }
                }
                "--recursive" | "--dereference-recursive" => recursive = true,
                "--ignore-case" => plan.ignore_case = Some(true),
                "--extended-regexp" => plan.flavor = Flavor::Extended,
                "--fixed-strings" => plan.flavor = Flavor::Fixed,
                "--perl-regexp" => plan.flavor = Flavor::Perl,
                "--word-regexp" => plan.word = true,
                "--files-with-matches" | "--count" => plan.files_output = true,
                "--regexp" => plan.patterns.push(argument()?),
                "--context" | "--after-context" | "--before-context" => {
                    let flag = match option.as_str() {
                        "--context" => 'C',
                        "--after-context" => 'A',
                        _ => 'B',
                    };
                    let value = argument();
                    if !set_context(&mut plan, flag, value.as_deref()) {
                        return None;
                    }
                }
                "--line-number" | "--with-filename" | "--no-filename" | "--no-messages"
                | "--color" | "--colour" | "--binary-files" => {}
                _ => return None,
            }
            index += 1;
            continue;
        }
        let characters: Vec<char> = value.chars().collect();
        let mut position = 1;
        while position < characters.len() {
            let flag = characters[position];
            match flag {
                'r' | 'R' => recursive = true,
                'n' | 'H' | 'h' | 's' | 'I' => {}
                'i' => plan.ignore_case = Some(true),
                'E' => plan.flavor = Flavor::Extended,
                'F' => plan.flavor = Flavor::Fixed,
                'G' => plan.flavor = Flavor::Basic,
                'P' => plan.flavor = Flavor::Perl,
                'w' => plan.word = true,
                'l' | 'c' => plan.files_output = true,
                'A' | 'B' | 'C' | 'e' => {
                    let inline: String = characters[position + 1..].iter().collect();
                    let argument = if inline.is_empty() {
                        index += 1;
                        words.get(index).map(|word| word.value.clone())
                    } else {
                        Some(inline)
                    };
                    if flag == 'e' {
                        plan.patterns.push(argument?);
                    } else if !set_context(&mut plan, flag, argument.as_deref()) {
                        return None;
                    }
                    break;
                }
                _ => return None,
            }
            position += 1;
        }
        index += 1;
    }
    if plan.patterns.is_empty() {
        if operands.is_empty() {
            return None;
        }
        let pattern = operands.remove(0);
        if pattern.glob {
            return None;
        }
        plan.patterns.push(pattern.value);
    }
    if operands.is_empty() && !recursive {
        return None;
    }
    plan.paths = if operands.is_empty() {
        vec![ShellWord {
            glob: false,
            value: ".".into(),
        }]
    } else {
        operands
    };
    Some(plan)
}

fn ripgrep_plan(words: &[ShellWord]) -> Option<Plan> {
    let mut plan = Plan::new(Flavor::Rust);
    let mut operands_only = false;
    let mut operands: Vec<ShellWord> = Vec::new();
    const IGNORED: [&str; 16] = [
        "-n",
        "-N",
        "-H",
        "--line-number",
        "--no-line-number",
        "--no-heading",
        "--heading",
        "--with-filename",
        "--hidden",
        "-.",
        "--follow",
        "-L",
        "--no-messages",
        "--color",
        "--colour",
        "--sort",
    ];
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        let value = word.value.as_str();
        if operands_only || !value.starts_with('-') || value == "-" {
            operands.push(word.clone());
            index += 1;
            continue;
        }
        if value == "--" {
            operands_only = true;
            index += 1;
            continue;
        }
        let (option, inline) = if value.starts_with("--") {
            split_long_option(value)
        } else {
            let split = value
                .char_indices()
                .nth(2)
                .map_or(value.len(), |(offset, _)| offset);
            (
                value[..split].to_string(),
                Some(value[split..].to_string()).filter(|rest| !rest.is_empty()),
            )
        };
        let mut argument = || {
            inline.clone().or_else(|| {
                index += 1;
                words.get(index).map(|word| word.value.clone())
            })
        };
        if IGNORED.contains(&option.as_str()) {
            if option == "--sort" && inline.is_none() {
                index += 1;
            }
            index += 1;
            continue;
        }
        match option.as_str() {
            "-i" | "--ignore-case" => plan.ignore_case = Some(true),
            "-s" | "--case-sensitive" => plan.ignore_case = Some(false),
            "-S" | "--smart-case" => plan.smart_case = true,
            "-F" | "--fixed-strings" => plan.flavor = Flavor::Fixed,
            "-P" | "--pcre2" => plan.flavor = Flavor::Perl,
            "-w" | "--word-regexp" => plan.word = true,
            "-l" | "-c" | "--files-with-matches" | "--count" | "--count-matches" => {
                plan.files_output = true
            }
            "-e" | "--regexp" => plan.patterns.push(argument()?),
            "-g" | "--glob" => {
                let glob = argument().filter(|glob| {
                    !glob.is_empty() && !glob.starts_with('!') && !glob.contains('/')
                })?;
                plan.globs.push(glob);
            }
            "-t" | "--type" => plan.globs.extend(
                ripgrep_type(&argument().unwrap_or_default())?
                    .iter()
                    .map(|glob| glob.to_string()),
            ),
            "-A" | "-B" | "-C" | "--after-context" | "--before-context" | "--context" => {
                let flag = match option.as_str() {
                    "--after-context" => 'A',
                    "--before-context" => 'B',
                    "--context" => 'C',
                    other => other.chars().nth(1).unwrap_or('C'),
                };
                let value = argument();
                if !set_context(&mut plan, flag, value.as_deref()) {
                    return None;
                }
            }
            _ => return None,
        }
        index += 1;
    }
    if plan.patterns.is_empty() {
        if operands.is_empty() {
            return None;
        }
        let pattern = operands.remove(0);
        if pattern.glob {
            return None;
        }
        plan.patterns.push(pattern.value);
    }
    plan.paths = if operands.is_empty() {
        vec![ShellWord {
            glob: false,
            value: ".".into(),
        }]
    } else {
        operands
    };
    Some(plan)
}

static SED_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+)(?:,(\d+|\$))?p$").expect("pattern"));

fn read_input(
    name: &str,
    args: &[ShellWord],
    head: Option<usize>,
    root: &str,
    directory: &str,
) -> Option<(Json, bool, Option<usize>)> {
    let file = |word: Option<&ShellWord>| {
        word.filter(|word| !word.glob)
            .and_then(|word| workspace_path(root, directory, &word.value))
    };
    let range = |target: &str, start: usize, end: usize| obj! { "target" => target, "range" => obj! { "startLine" => start, "endLine" => end } };
    match name {
        "cat" => {
            let operands: Vec<&ShellWord> = args.iter().filter(|word| word.value != "-n").collect();
            let target = if operands.len() == 1 {
                file(Some(operands[0]))?
            } else {
                return None;
            };
            Some((
                match head {
                    Some(lines) => range(&target, 1, lines),
                    None => obj! { "target" => target.as_str(), "view" => "raw" },
                },
                false,
                None,
            ))
        }
        _ if head.is_some() => None,
        "ls" => {
            let operands: Vec<&ShellWord> = args.iter().filter(|word| word.value != "-1").collect();
            if operands.len() > 1
                || operands
                    .first()
                    .is_some_and(|word| word.value.starts_with('-'))
            {
                return None;
            }
            let dot = ShellWord {
                glob: false,
                value: ".".into(),
            };
            let target = file(Some(operands.first().copied().unwrap_or(&dot)))?;
            Some((obj! { "target" => target }, true, None))
        }
        "head" | "tail" => {
            let target = file(args.last())?;
            let lines = head_count(&args[..args.len() - 1])?;
            Some(if name == "head" {
                (range(&target, 1, lines), false, None)
            } else {
                (obj! { "target" => target }, false, Some(lines))
            })
        }
        "sed" if args.len() == 3 && args[0].value == "-n" => {
            let script = SED_SCRIPT.captures(&args[1].value)?;
            let target = file(Some(&args[2]))?;
            let start: usize = script[1].parse().ok()?;
            let end: usize = match script.get(2).map(|value| value.as_str()) {
                Some("$") => 9_007_199_254_740_991,
                Some(value) => value.parse().ok()?,
                None => start,
            };
            (start >= 1 && end >= start).then(|| (range(&target, start, end), false, None))
        }
        _ => None,
    }
}

static HEAD_COUNT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:-(\d+)|-n\s*(\d+)|--lines=(\d+))$").expect("pattern"));

fn head_count(args: &[ShellWord]) -> Option<usize> {
    if args.is_empty() {
        return Some(10);
    }
    let joined = args
        .iter()
        .map(|word| word.value.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let captures = HEAD_COUNT.captures(&joined)?;
    let lines: usize = captures
        .get(1)
        .or(captures.get(2))
        .or(captures.get(3))?
        .as_str()
        .parse()
        .ok()?;
    (1..=10_000).contains(&lines).then_some(lines)
}

/// A workspace-relative path; none outside the workspace or inside dependencies.
fn workspace_path(root: &str, directory: &str, value: &str) -> Option<String> {
    let relative = if crate::pathx::is_absolute(value) {
        if value == root {
            ".".to_string()
        } else {
            value.strip_prefix(&format!("{root}/"))?.to_string()
        }
    } else {
        format!("{directory}/{value}")
    };
    let normalized = posix_normalize(&relative);
    let normalized = normalized.trim_end_matches('/');
    let normalized = if normalized.is_empty() {
        "."
    } else {
        normalized
    };
    if normalized == ".."
        || normalized.starts_with("../")
        || normalized.split('/').any(|part| part == "node_modules")
    {
        return None;
    }
    Some(normalized.to_string())
}

/// `path.posix.normalize` of a relative path.
fn posix_normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn search_scopes(paths: &[ShellWord], globs: &[String]) -> Vec<String> {
    if globs.is_empty() {
        return paths.iter().map(|path| path.value.clone()).collect();
    }
    paths
        .iter()
        .flat_map(|path| {
            if path.glob {
                return vec![path.value.clone()];
            }
            globs
                .iter()
                .flat_map(|glob| {
                    let mut scopes = vec![if path.value == "." {
                        format!("**/{glob}")
                    } else {
                        format!("{}/**/{glob}", path.value)
                    }];
                    if glob_matches(crate::pathx::basename(&path.value), glob) {
                        scopes.push(path.value.clone());
                    }
                    scopes
                })
                .collect()
        })
        .collect()
}

static ALTERNATIVES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*)\{([^{}]+)\}(.*)$").expect("pattern"));

fn glob_matches(name: &str, glob: &str) -> bool {
    let patterns: Vec<String> = match ALTERNATIVES.captures(glob) {
        Some(captures) => captures[2]
            .split(',')
            .map(|part| format!("{}{part}{}", &captures[1], &captures[3]))
            .collect(),
        None => vec![glob.to_string()],
    };
    patterns.iter().any(|pattern| {
        let source: String = pattern
            .chars()
            .map(|character| match character {
                '*' => "[^/]*".to_string(),
                '?' => "[^/]".to_string(),
                other => escape_regex(&other.to_string()),
            })
            .collect();
        Regex::new(&format!("^{source}$")).is_ok_and(|expression| expression.is_match(name))
    })
}

static BACKREFERENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[1-9]").expect("pattern"));
static LOOKAROUND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\?<?[=!]").expect("pattern"));

/// grep's dialects as ripgrep's Rust regex, or none when unsupported.
fn rust_pattern(pattern: &str, flavor: Flavor) -> Option<String> {
    if flavor == Flavor::Fixed {
        return Some(escape_regex(pattern));
    }
    if BACKREFERENCE.is_match(pattern) || LOOKAROUND.is_match(pattern) {
        return None;
    }
    let words = pattern.replace("\\<", "\\b").replace("\\>", "\\b");
    Some(literal_braces(&if flavor == Flavor::Basic {
        basic_to_extended(&words)
    } else {
        words
    }))
}

/// Basic regex escapes ( ) { } | + ? to make them operators; bare ones are
/// literal. Bracket expressions are copied.
fn basic_to_extended(pattern: &str) -> String {
    let characters: Vec<char> = pattern.chars().collect();
    let mut output = String::new();
    let mut bracket: Option<usize> = None;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if let Some(start) = bracket {
            let inside = output[start + 1..].to_string();
            output.push(character);
            if character == ']' && !inside.is_empty() && inside != "^" {
                bracket = None;
            }
        } else if character == '[' {
            bracket = Some(output.len());
            output.push(character);
        } else if character == '\\' && index + 1 < characters.len() {
            index += 1;
            let next = characters[index];
            if "(){}|+?".contains(next) {
                output.push(next);
            } else {
                output.push('\\');
                output.push(next);
            }
        } else if "(){}|+?".contains(character) {
            output.push('\\');
            output.push(character);
        } else {
            output.push(character);
        }
        index += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_and_classifies() {
        let routes = shell_inspection_routes(
            "cd src && grep -rn 'foo(' . | grep -v test | head -5",
            None,
            "/r",
        )
        .unwrap();
        let Route::Search {
            request,
            presented_whole,
            ..
        } = &routes[0]
        else {
            panic!("search")
        };
        assert_eq!(request.get("query").and_then(Json::as_str), Some("foo\\("));
        assert_eq!(request.get("limit").and_then(Json::as_f64), Some(5.0));
        assert!(!presented_whole);
        let routes = shell_inspection_routes("sed -n 3,9p a.ts", None, "/r").unwrap();
        let Route::Read { input, .. } = &routes[0] else {
            panic!("read")
        };
        assert_eq!(
            input.stringify(),
            r#"{"target":"a.ts","range":{"startLine":3,"endLine":9}}"#
        );
        assert_eq!(
            read_only_inspection("grep -rn x . 2>/dev/null"),
            Some("search")
        );
        assert_eq!(read_only_inspection("cat a > b"), None);
        assert_eq!(read_only_inspection("ls >/dev/null"), Some("read"));
        assert_eq!(read_only_inspection("ls > /dev/null"), None);
        assert!(shell_inspection_routes("cat ../x", None, "/r").is_none());
    }
}
