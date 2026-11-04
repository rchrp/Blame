import { posix } from "node:path";
import type { LightReadCodeInput, LightToolResult } from "./light-contracts.js";
import type { CodeSearchRequest } from "./light-code-search.js";
import { escapeRegex } from "./lexical-search.js";
import { recordValue } from "./light-navigation.js";
import {
  literalShellStatements,
  shellCommandNames,
  type ShellCommand,
  type ShellWord,
} from "./shell-words.js";

/**
 * A read-only shell inspection answered by a harness tool instead of the
 * shell, so its observations carry aliases, read coverage and line numbers.
 */
export type ShellInspectionRoute =
  | { command: string; tool: "search_code"; request: CodeSearchRequest }
  | { command: string; tool: "read_code"; input: LightReadCodeInput; listing?: boolean; tailLines?: number };

export type ShellInspectionPorts = {
  lineCount(path: string): Promise<number>;
  read(input: LightReadCodeInput): Promise<LightToolResult<unknown>>;
  search(request: CodeSearchRequest): Promise<LightToolResult<unknown>>;
};

type Location = { directory: string; root: string };
type Filters = { exclude?: (line: string) => boolean; head?: number };
type Flavor = "basic" | "extended" | "fixed" | "perl" | "rust";
type Plan = {
  after: number;
  before: number;
  flavor: Flavor;
  globs: string[];
  ignoreCase?: boolean;
  output: "files" | "matches";
  paths: ShellWord[];
  patterns: string[];
  smartCase?: boolean;
  word: boolean;
};

const routedMatchLimit = 50;
const routedFileLimit = 100;
const maximumContext = 30;
const ignorableDirectories = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "out"]);
const readOnlyCommands = new Set([
  "basename", "cat", "cd", "cut", "dirname", "du", "echo", "egrep", "fgrep", "file", "find", "grep", "head",
  "ls", "nl", "printf", "pwd", "realpath", "rg", "sed", "sort", "stat", "tail", "test", "tr", "true", "uniq", "wc", "which",
]);
const ripgrepTypes: Record<string, string[]> = {
  css: ["*.css"], go: ["*.go"], html: ["*.html", "*.htm"], java: ["*.java"], js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  json: ["*.json"], markdown: ["*.md", "*.markdown"], md: ["*.md", "*.markdown"], py: ["*.py"], rust: ["*.rs"],
  sh: ["*.sh"], ts: ["*.ts", "*.tsx", "*.mts", "*.cts"], yaml: ["*.yaml", "*.yml"],
};

/**
 * Translates `cd`, grep, rg, cat, head, tail and `sed -n` invocations, with
 * `| grep -v`, `| head` and stderr redirections, into tool requests. Returns
 * undefined whenever the shell could behave differently, so the command runs.
 */
export function shellInspectionRoutes(command: string, location: { cwd?: string; root: string }): ShellInspectionRoute[] | undefined {
  const statements = literalShellStatements(command);
  const start = statements ? workspacePath(location.root, ".", location.cwd ?? ".") : undefined;
  if (!statements || start === undefined) return undefined;
  const current: Location = { directory: start, root: location.root };
  const routes: ShellInspectionRoute[] = [];
  for (const statement of statements) {
    const [first, ...rest] = statement.pipeline;
    if (!first) return undefined;
    if (first.words[0]?.value === "cd" && !rest.length && !routes.length) {
      const target = first.words.length === 2 ? workspacePath(current.root, current.directory, first.words[1]!.value) : undefined;
      if (target === undefined) return undefined;
      current.directory = target;
      continue;
    }
    const filters = pipelineFilters(rest);
    const route = filters && inspectionRoute(first, filters, current, statement.text);
    if (!route) return undefined;
    routes.push(route);
  }
  return routes.length && routes.length <= 4 ? routes : undefined;
}

/** Answers routed inspections, or undefined when any of them needs the shell after all. */
export async function answerShellInspection(command: string, routes: ShellInspectionRoute[], ports: ShellInspectionPorts) {
  const answers: Record<string, unknown>[] = [];
  for (const route of routes) {
    const result = route.tool === "search_code"
      ? await ports.search(route.request)
      : await ports.read(await tailInput(route, ports));
    const data = recordValue(result.status === "ok" ? result.data : undefined);
    const listing = route.tool === "read_code" && route.listing === true;
    if (result.status !== "ok" || data.scopeStatus === "empty" || (data.view === "directory") !== listing) return undefined;
    answers.push({ command: route.command, servedBy: route.tool, ...presentedData(route, data), ...(result.receipt ? { receipt: result.receipt } : {}) });
  }
  const guidance = "Answered by search_code/read_code instead of the shell: results carry sN aliases, read coverage and line numbers. Call those tools directly for source inspection.";
  const data = answers.length === 1 ? { ...answers[0], command, guidance } : { command, answers, guidance };
  return { status: "ok", data } satisfies LightToolResult<unknown>;
}

/**
 * Classifies a command that only reads the workspace: "search" when it runs
 * grep or rg, whose exit status 1 means that nothing matched; "read"
 * otherwise. Returns undefined for anything that may write or run code.
 */
export function readOnlyInspection(command: string): "read" | "search" | undefined {
  const names = shellCommandNames(command);
  if (!names?.length || !names.every((name) => readOnlyCommands.has(name))) return undefined;
  if (/(?:^|[^\w&>-])>{1,2}\s*(?!\/dev\/null\b|&\d)/u.test(command.replace(/2>&1|2>\s*\/dev\/null/gu, ""))) return undefined;
  if (names.includes("sed") && /\bsed\b[^|;&]*\s-[a-zA-Z]*i/u.test(command)) return undefined;
  if (names.includes("find") && /\s-(?:exec|execdir|delete|ok|fprint)\b/u.test(command)) return undefined;
  return names.some((name) => ["egrep", "fgrep", "grep", "rg"].includes(name)) ? "search" : "read";
}

function presentedData(route: ShellInspectionRoute, data: Record<string, unknown>) {
  if (route.tool !== "search_code") return data;
  const request = route.request;
  // A grep filter or one-sided context cannot be expressed as a search_code call.
  if (!request.excludeLine && request.contextBefore === request.contextAfter) return data;
  const presented = { ...data };
  delete presented.nextSearch;
  return presented;
}

async function tailInput(route: Extract<ShellInspectionRoute, { tool: "read_code" }>, ports: ShellInspectionPorts) {
  if (!route.tailLines) return route.input;
  const total = await ports.lineCount(route.input.target);
  return { target: route.input.target, range: { startLine: Math.max(1, total - route.tailLines + 1), endLine: Math.max(1, total) } };
}

function pipelineFilters(commands: ShellCommand[]): Filters | undefined {
  const filters: Filters = {};
  const excludes: Array<(line: string) => boolean> = [];
  for (const [index, command] of commands.entries()) {
    const name = command.words[0]?.value;
    if (name === "head" && index === commands.length - 1) {
      const lines = headCount(command.words.slice(1));
      if (lines === undefined) return undefined;
      filters.head = lines;
    } else if (name === "grep" || name === "egrep") {
      const exclude = excludeFilter(command.words);
      if (!exclude) return undefined;
      excludes.push(exclude);
    } else return undefined;
  }
  if (excludes.length) filters.exclude = (line) => excludes.some((exclude) => exclude(line));
  return filters;
}

/** `grep -v PATTERN` applied to a previous command's output lines. */
function excludeFilter(words: ShellWord[]) {
  let inverted = false, ignoreCase = false, flavor: Flavor = words[0]?.value === "egrep" ? "extended" : "basic";
  const operands: ShellWord[] = [];
  for (const word of words.slice(1)) {
    if (/^-[a-zA-Z]+$/u.test(word.value)) {
      for (const flag of word.value.slice(1)) {
        if (flag === "v") inverted = true;
        else if (flag === "i") ignoreCase = true;
        else if (flag === "E") flavor = "extended";
        else if (flag === "F") flavor = "fixed";
        else return undefined;
      }
    } else operands.push(word);
  }
  const pattern = operands.length === 1 && !operands[0]!.glob ? operands[0]!.value : undefined;
  const source = inverted && pattern !== undefined ? rustPattern(pattern, flavor) : undefined;
  if (source === undefined) return undefined;
  try {
    const expression = new RegExp(source, ignoreCase ? "iu" : "u");
    return (line: string) => expression.test(line);
  } catch {
    return undefined;
  }
}

function inspectionRoute(command: ShellCommand, filters: Filters, location: Location, text: string): ShellInspectionRoute | undefined {
  const name = command.words[0]?.value;
  const plan = name === "grep" || name === "egrep" || name === "fgrep"
    ? grepPlan(command.words)
    : name === "rg" ? ripgrepPlan(command.words) : undefined;
  if (plan) return searchRoute(plan, filters, location, text);
  if (filters.exclude || name === undefined) return undefined;
  const input = readInput(name, command.words.slice(1), filters.head, location);
  if (!input) return undefined;
  const { listing, tailLines, ...read } = input;
  return { command: text, tool: "read_code", input: read, ...(listing ? { listing } : {}), ...(tailLines ? { tailLines } : {}) };
}

function searchRoute(plan: Plan, filters: Filters, location: Location, text: string): ShellInspectionRoute | undefined {
  const patterns = plan.patterns.map((pattern) => rustPattern(pattern, plan.flavor));
  if (!patterns.length || patterns.some((pattern) => pattern === undefined || !pattern.length)) return undefined;
  const joined = patterns.length === 1 ? patterns[0]! : patterns.map((pattern) => `(?:${pattern})`).join("|");
  const query = plan.word ? `\\b(?:${joined})\\b` : joined;
  const paths = plan.paths.map((path) => ({ ...path, value: workspacePath(location.root, location.directory, path.value) }));
  if (paths.some((path) => path.value === undefined)) return undefined;
  const scope = searchScopes(paths as ShellWord[], plan.globs);
  if (!scope) return undefined;
  const caseSensitive = plan.smartCase ? /\p{Lu}/u.test(plan.patterns.join("")) : !plan.ignoreCase;
  const request: CodeSearchRequest = {
    query,
    mode: "regex",
    scope,
    caseSensitive,
    limit: Math.min(filters.head ?? (plan.output === "files" ? routedFileLimit : routedMatchLimit), 100),
    ...(plan.output === "files" ? { output: "files" as const } : {}),
    ...(plan.before || plan.after ? { contextBefore: plan.before, contextAfter: plan.after } : {}),
    ...(filters.exclude ? { excludeLine: filters.exclude } : {}),
  };
  return { command: text, tool: "search_code", request };
}

function grepPlan(words: ShellWord[]): Plan | undefined {
  const name = words[0]!.value;
  const plan: Plan = { after: 0, before: 0, flavor: name === "egrep" ? "extended" : name === "fgrep" ? "fixed" : "basic",
    globs: [], output: "matches", paths: [], patterns: [], word: false };
  let recursive = false, operandsOnly = false;
  const operands: ShellWord[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    const value = word.value;
    if (operandsOnly || !value.startsWith("-") || value === "-") {
      operands.push(word);
      continue;
    }
    if (value === "--") {
      operandsOnly = true;
      continue;
    }
    if (value.startsWith("--")) {
      const [option, inline] = splitLongOption(value);
      const argument = () => inline ?? words[++index]?.value;
      if (option === "--include") { const glob = argument(); if (!glob) return undefined; plan.globs.push(glob); }
      else if (option === "--exclude-dir") { if (!ignorableDirectories.has(argument() ?? "")) return undefined; }
      else if (option === "--recursive" || option === "--dereference-recursive") recursive = true;
      else if (option === "--ignore-case") plan.ignoreCase = true;
      else if (option === "--extended-regexp") plan.flavor = "extended";
      else if (option === "--fixed-strings") plan.flavor = "fixed";
      else if (option === "--perl-regexp") plan.flavor = "perl";
      else if (option === "--word-regexp") plan.word = true;
      else if (option === "--files-with-matches" || option === "--count") plan.output = "files";
      else if (option === "--regexp") { const pattern = argument(); if (pattern === undefined) return undefined; plan.patterns.push(pattern); }
      else if (option === "--context" || option === "--after-context" || option === "--before-context") {
        if (!setContext(plan, option === "--context" ? "C" : option === "--after-context" ? "A" : "B", argument())) return undefined;
      } else if (!["--line-number", "--with-filename", "--no-filename", "--no-messages", "--color", "--colour", "--binary-files"].includes(option))
        return undefined;
      continue;
    }
    for (let position = 1; position < value.length; position += 1) {
      const flag = value[position]!;
      if (flag === "r" || flag === "R") recursive = true;
      else if ("nHhsI".includes(flag)) continue;
      else if (flag === "i") plan.ignoreCase = true;
      else if (flag === "E") plan.flavor = "extended";
      else if (flag === "F") plan.flavor = "fixed";
      else if (flag === "G") plan.flavor = "basic";
      else if (flag === "P") plan.flavor = "perl";
      else if (flag === "w") plan.word = true;
      else if (flag === "l" || flag === "c") plan.output = "files";
      else if (flag === "A" || flag === "B" || flag === "C" || flag === "e") {
        const argument = value.slice(position + 1) || words[++index]?.value;
        if (flag === "e") { if (argument === undefined) return undefined; plan.patterns.push(argument); }
        else if (!setContext(plan, flag, argument)) return undefined;
        break;
      } else return undefined;
    }
  }
  if (!plan.patterns.length) {
    const pattern = operands.shift();
    if (!pattern || pattern.glob) return undefined;
    plan.patterns.push(pattern.value);
  }
  if (!operands.length && !recursive) return undefined;
  plan.paths = operands.length ? operands : [{ glob: false, value: "." }];
  return plan;
}

function ripgrepPlan(words: ShellWord[]): Plan | undefined {
  const plan: Plan = { after: 0, before: 0, flavor: "rust", globs: [], output: "matches", paths: [], patterns: [], word: false };
  let operandsOnly = false;
  const operands: ShellWord[] = [];
  const ignored = ["-n", "-N", "-H", "--line-number", "--no-line-number", "--no-heading", "--heading", "--with-filename", "--hidden", "-.", "--follow", "-L", "--no-messages", "--color", "--colour", "--sort"];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    const value = word.value;
    if (operandsOnly || !value.startsWith("-") || value === "-") { operands.push(word); continue; }
    if (value === "--") { operandsOnly = true; continue; }
    const [option, inline] = value.startsWith("--") ? splitLongOption(value) : [value.slice(0, 2), value.slice(2) || undefined];
    const argument = () => inline ?? words[++index]?.value;
    if (ignored.includes(option)) { if (option === "--sort" && inline === undefined) index += 1; continue; }
    if (option === "-i" || option === "--ignore-case") plan.ignoreCase = true;
    else if (option === "-s" || option === "--case-sensitive") plan.ignoreCase = false;
    else if (option === "-S" || option === "--smart-case") plan.smartCase = true;
    else if (option === "-F" || option === "--fixed-strings") plan.flavor = "fixed";
    else if (option === "-P" || option === "--pcre2") plan.flavor = "perl";
    else if (option === "-w" || option === "--word-regexp") plan.word = true;
    else if (["-l", "-c", "--files-with-matches", "--count", "--count-matches"].includes(option)) plan.output = "files";
    else if (option === "-e" || option === "--regexp") { const pattern = argument(); if (pattern === undefined) return undefined; plan.patterns.push(pattern); }
    else if (option === "-g" || option === "--glob") {
      const glob = argument();
      if (!glob || glob.startsWith("!") || glob.includes("/")) return undefined;
      plan.globs.push(glob);
    } else if (option === "-t" || option === "--type") {
      const globs = ripgrepTypes[argument() ?? ""];
      if (!globs) return undefined;
      plan.globs.push(...globs);
    } else if (["-A", "-B", "-C", "--after-context", "--before-context", "--context"].includes(option)) {
      const flag = option === "--after-context" ? "A" : option === "--before-context" ? "B" : option === "--context" ? "C" : option[1]!;
      if (!setContext(plan, flag, argument())) return undefined;
    } else return undefined;
  }
  if (!plan.patterns.length) {
    const pattern = operands.shift();
    if (!pattern || pattern.glob) return undefined;
    plan.patterns.push(pattern.value);
  }
  plan.paths = operands.length ? operands : [{ glob: false, value: "." }];
  return plan;
}

function setContext(plan: Plan, flag: string, value?: string) {
  const lines = value && /^\d+$/u.test(value) ? Math.min(Number(value), maximumContext) : undefined;
  if (lines === undefined) return false;
  if (flag === "A" || flag === "C") plan.after = lines;
  if (flag === "B" || flag === "C") plan.before = lines;
  return true;
}

function splitLongOption(value: string): [string, string | undefined] {
  const separator = value.indexOf("=");
  return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)];
}

function readInput(name: string, args: ShellWord[], head: number | undefined, location: Location):
  (LightReadCodeInput & { listing?: boolean; tailLines?: number }) | undefined {
  const file = (word?: ShellWord) => word && !word.glob ? workspacePath(location.root, location.directory, word.value) : undefined;
  if (name === "cat") {
    const operands = args.filter((word) => word.value !== "-n");
    const target = operands.length === 1 ? file(operands[0]) : undefined;
    if (!target) return undefined;
    return head ? { target, range: { startLine: 1, endLine: head } } : { target, view: "raw" };
  }
  if (head !== undefined) return undefined;
  if (name === "ls") {
    const operands = args.filter((word) => word.value !== "-1");
    const target = operands.length <= 1 && !operands[0]?.value.startsWith("-") ? file(operands[0] ?? { glob: false, value: "." }) : undefined;
    return target ? { target, listing: true } : undefined;
  }
  if (name === "head" || name === "tail") {
    const target = file(args.at(-1));
    const lines = headCount(args.slice(0, -1));
    if (!target || lines === undefined) return undefined;
    return name === "head" ? { target, range: { startLine: 1, endLine: lines } } : { target, tailLines: lines };
  }
  if (name === "sed" && args.length === 3 && args[0]!.value === "-n") {
    const script = /^(\d+)(?:,(\d+|\$))?p$/u.exec(args[1]!.value);
    const target = file(args[2]);
    if (!script || !target) return undefined;
    const startLine = Number(script[1]);
    const endLine = script[2] === "$" ? Number.MAX_SAFE_INTEGER : Number(script[2] ?? script[1]);
    return startLine >= 1 && endLine >= startLine ? { target, range: { startLine, endLine } } : undefined;
  }
  return undefined;
}

function headCount(args: ShellWord[]) {
  if (!args.length) return 10;
  const joined = args.map((word) => word.value).join(" ");
  const match = /^(?:-(\d+)|-n\s*(\d+)|--lines=(\d+))$/u.exec(joined);
  const lines = match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
  return lines && lines <= 10_000 ? lines : undefined;
}

/** A workspace-relative path, or undefined outside the workspace or inside dependencies. */
function workspacePath(root: string, directory: string, value: string) {
  const relative = posix.isAbsolute(value)
    ? value === root ? "." : value.startsWith(`${root}/`) ? value.slice(root.length + 1) : undefined
    : posix.join(directory, value);
  if (relative === undefined) return undefined;
  const normalized = posix.normalize(relative).replace(/\/+$/u, "") || ".";
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("node_modules")) return undefined;
  return normalized;
}

function searchScopes(paths: ShellWord[], globs: string[]) {
  if (!globs.length) return paths.map((path) => path.value);
  return paths.flatMap((path) => path.glob ? [path.value] : globs.flatMap((glob) => [
    path.value === "." ? `**/${glob}` : `${path.value}/**/${glob}`,
    ...(globMatches(posix.basename(path.value), glob) ? [path.value] : []),
  ]));
}

function globMatches(name: string, glob: string) {
  const alternatives = /^(.*)\{([^{}]+)\}(.*)$/u.exec(glob);
  const patterns = alternatives ? alternatives[2]!.split(",").map((part) => `${alternatives[1]}${part}${alternatives[3]}`) : [glob];
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.split("").map((character) =>
      character === "*" ? "[^/]*" : character === "?" ? "[^/]" : escapeRegex(character)).join("")}$`, "u").test(name));
}

/** grep's pattern dialects rewritten for ripgrep's Rust regex syntax, or undefined when unsupported. */
function rustPattern(pattern: string, flavor: Flavor) {
  if (flavor === "fixed") return escapeRegex(pattern);
  if (/\\[1-9]/u.test(pattern) || /\(\?<?[=!]/u.test(pattern)) return undefined;
  const words = pattern.replaceAll("\\<", "\\b").replaceAll("\\>", "\\b");
  return flavor === "basic" ? basicToExtended(words) : words;
}

/** Basic regex escapes ( ) { } | + ? to make them operators; bare ones are literal. Bracket expressions are copied. */
function basicToExtended(pattern: string) {
  let output = "";
  let bracket = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (bracket >= 0) {
      const inside = output.slice(bracket + 1);
      output += character;
      if (character === "]" && inside !== "" && inside !== "^") bracket = -1;
      continue;
    }
    if (character === "[") {
      bracket = output.length;
      output += character;
    } else if (character === "\\" && index + 1 < pattern.length) {
      const next = pattern[++index]!;
      output += "(){}|+?".includes(next) ? next : `\\${next}`;
    } else output += "(){}|+?".includes(character) ? `\\${character}` : character;
  }
  return output;
}
