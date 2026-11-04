import type { SgNode } from "@ast-grep/napi";
import { parseCode } from "./code-intelligence.js";

/** A shell word after quote removal. `glob` marks unquoted *, ? or [ that the shell would expand. */
export type ShellWord = { glob: boolean; value: string };

/** One simple command of a pipeline, as literal words. */
export type ShellCommand = { words: ShellWord[] };

/** A statement: commands joined by `|`, run after the previous statement succeeded. */
export type ShellStatement = { pipeline: ShellCommand[]; text: string };

/**
 * Splits a command line into statements joined by `;` or `&&`, keeping only
 * what a literal reading can represent: words without expansions, harmless
 * stderr redirections, and no `||`, subshells, loops or assignments.
 * Returns undefined when any part needs the shell to interpret it.
 */
export function literalShellStatements(command: string): ShellStatement[] | undefined {
  const root = parseCode("command.sh", Buffer.from(command)).trees[0]?.root;
  if (!root || root.kind() !== "program") return undefined;
  const statements: ShellStatement[] = [];
  for (const node of statementNodes(root) ?? []) {
    const pipeline = pipelineCommands(node);
    if (!pipeline) return undefined;
    statements.push({ pipeline, text: node.text() });
  }
  return statements.length ? statements : undefined;
}

/** Every command name in the line, including nested ones, or undefined when it cannot be parsed. */
export function shellCommandNames(command: string) {
  const root = parseCode("command.sh", Buffer.from(command)).trees[0]?.root;
  if (!root || root.findAll({ rule: { kind: "ERROR" } }).length) return undefined;
  return root.findAll({ rule: { kind: "command_name" } }).map((node) => node.text());
}

function statementNodes(root: SgNode): SgNode[] | undefined {
  const nodes: SgNode[] = [];
  for (const child of root.children()) {
    const kind = child.kind();
    if (kind === ";" || kind === "comment") continue;
    if (kind === "list") {
      const parts = listParts(child);
      if (!parts) return undefined;
      nodes.push(...parts);
    } else nodes.push(child);
  }
  return nodes;
}

function listParts(node: SgNode): SgNode[] | undefined {
  const parts: SgNode[] = [];
  for (const child of node.children()) {
    const kind = child.kind();
    if (kind === "&&") continue;
    if (kind === "list") {
      const nested = listParts(child);
      if (!nested) return undefined;
      parts.push(...nested);
    } else if (kind === "command" || kind === "pipeline" || kind === "redirected_statement") parts.push(child);
    else return undefined;
  }
  return parts;
}

function pipelineCommands(node: SgNode): ShellCommand[] | undefined {
  const body = withoutHarmlessRedirects(node);
  if (!body) return undefined;
  if (body.kind() === "command") {
    const command = commandWords(body);
    return command ? [command] : undefined;
  }
  if (body.kind() !== "pipeline") return undefined;
  const commands: ShellCommand[] = [];
  for (const child of body.children()) {
    if (child.kind() === "|") continue;
    const element = withoutHarmlessRedirects(child);
    const command = element?.kind() === "command" ? commandWords(element) : undefined;
    if (!command) return undefined;
    commands.push(command);
  }
  return commands;
}

function withoutHarmlessRedirects(node: SgNode): SgNode | undefined {
  if (node.kind() !== "redirected_statement") return node;
  const [body, ...redirects] = node.children();
  const harmless = redirects.every((redirect) =>
    /^(?:2>\s*\/dev\/null|2>&1|>\s*\/dev\/null)$/u.test(redirect.text().replace(/\s+/gu, " ").trim()));
  return body && harmless ? body : undefined;
}

function commandWords(node: SgNode): ShellCommand | undefined {
  const words: ShellWord[] = [];
  for (const child of node.children()) {
    const target = child.kind() === "command_name" ? child.children()[0] : child;
    const word = target ? literalWord(target) : undefined;
    if (!word) return undefined;
    words.push(word);
  }
  return words.length ? { words } : undefined;
}

function literalWord(node: SgNode): ShellWord | undefined {
  const kind = node.kind();
  const text = node.text();
  if (kind === "word" || kind === "number") {
    if (/[$`]/u.test(text) || text.startsWith("~")) return undefined;
    return { glob: /(?<!\\)[*?[]/u.test(text), value: text.replace(/\\(.)/gsu, "$1") };
  }
  if (kind === "raw_string") return { glob: false, value: text.slice(1, -1) };
  if (kind === "string") {
    const parts = node.children().filter((child) => child.kind() !== '"');
    if (parts.some((child) => child.kind() !== "string_content")) return undefined;
    return { glob: false, value: parts.map((child) => child.text()).join("").replace(/\\([$`"\\\n])/gu, "$1") };
  }
  if (kind === "concatenation") {
    const parts = node.children().map(literalWord);
    if (parts.some((part) => !part)) return undefined;
    return { glob: parts.some((part) => part!.glob), value: parts.map((part) => part!.value).join("") };
  }
  return undefined;
}
