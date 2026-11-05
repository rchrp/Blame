import type { SgNode } from "@ast-grep/napi";
import { parseCode } from "./code-intelligence.js";
import type { LightTaskContract } from "./light-contracts.js";

export const blockedCommandParts = [
  "rm -rf",
  "sudo",
  "curl | sh",
  "wget | sh",
  "> /dev/",
];

export function blockedCommandReason(command: string, environment?: LightTaskContract["environment"]) {
  const root = parseCode("command.sh", Buffer.from(command)).trees[0]?.root;
  if (!root) return "Unable to inspect the shell command syntax.";
  if (environment?.managedPreview !== false && hasBackgroundProcess(root))
    return "Long-running processes must use the managed preview runtime.";
  const invocations = root
    .findAll({ rule: { kind: "command" } })
    .map(commandInvocation);
  const scratch = scratchVariables(root);
  const denied = invocations
    .filter((value) => !scratchDeletion(value, scratch))
    .map((value) => blockedInvocationReason(value, environment))
    .find(Boolean);
  if (denied) return denied;
  if (
    root
      .findAll({ rule: { kind: "pipeline" } })
      .some((node) => remoteScript.test(node.text()))
  )
    return "Remote scripts cannot be piped into a shell.";
  return undefined;
}

function blockedInvocationReason(command: string, environment?: LightTaskContract["environment"]): string | undefined {
  const normalized = command.toLocaleLowerCase();
  if (
    managedInfrastructure.test(normalized) &&
    !(environment?.managedPreview !== false && containerListing.test(normalized)) &&
    (environment?.managedPreview !== false || !environment.isolated)
  )
    return environment?.managedPreview === false
      ? "Infrastructure commands require an isolated task environment."
      : "Managed preview infrastructure cannot be started from run_task.";
  if (!environment?.isolated && processControl.test(normalized) && !signalInspection(command))
    return "Direct process control is unavailable in this workspace.";
  if (
    environment?.managedPreview !== false &&
    (longRunningProcess.test(normalized) || unmanagedViteCommand(normalized))
  )
    return "Long-running processes must use the managed preview runtime.";
  if (!environment?.isolated && destructiveFileCommand.test(normalized))
    return "Use edit_code for file deletion; destructive filesystem commands are unavailable, except for scratch files the same command created with F=$(mktemp -d) or placed under $TMPDIR.";
  if (packageManagerMutation.test(normalized) && !lockfileInstall(normalized))
    return "Use the dependency operation for Node package changes. To restore node_modules from the lockfile, run `pnpm install --frozen-lockfile` (or `npm ci`).";
  if (!environment?.isolated && deniedGitCommand(command))
    return "Git mutations are unavailable from run_task.";
  if (/^sudo(?:\s|$)/u.test(normalized))
    return "Privilege escalation is unavailable from run_task.";
  const unwrapped = command.replace(
    /^(?:(?:command|exec|env)\s+(?:[^\s=]+=[^\s]+\s+)*|(?:npm|pnpm|yarn|bun)\s+exec\s+(?:--\s+)?|(?:npx|bunx|(?:pnpm|yarn)\s+dlx)\s+(?:(?:-y|--yes|--)\s+)*)/u,
    "",
  );
  return unwrapped === command ? undefined : blockedInvocationReason(unwrapped, environment);
}

function commandInvocation(node: SgNode) {
  const children = node.children();
  const nameIndex = children.findIndex(
    (child) => child.kind() === "command_name",
  );
  return children
    .slice(nameIndex)
    .map((child) => child.text())
    .join(" ");
}

function hasBackgroundProcess(node: SgNode): boolean {
  return node.kind() === "&" || node.children().some(hasBackgroundProcess);
}

const managedInfrastructure =
  /^(?:docker|docker-compose|nerdctl|podman|postgres|pg_ctl|createdb|initdb)(?:\s|$)/u;
const longRunningProcess =
  /^(?:next\s+(?:dev|start)|pnpm\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|npm\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|yarn\s+(?:dev|preview|start|serve|watch)|bun\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|nohup)(?:\s|$)/u;
// Listing what runs beside the managed preview starts nothing and shows no
// environment values (inspect, logs and config can print the preview's secrets).
const containerListing =
  /^(?:docker|podman|nerdctl)(?:\s+(?:compose|container|image|network|volume))?\s+(?:ps|ls|images|version|info)(?:\s|$)|^docker-compose\s+(?:ps|ls|version)(?:\s|$)/u;
const processControl = /^(?:kill|pkill)(?:\s|$)/u;
const destructiveFileCommand = /^(?:rm|rmdir|dd|chown)(?:\s|$)/u;
const packageManagerMutation =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:add|ci|install|link|remove|uninstall|unlink|update|upgrade))/u;
const remoteScript = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/u;
const allowedGitCommands = new Set([
  "annotate",
  "blame",
  "cat-file",
  "clone",
  "version",
  "help",
  "describe",
  "rev-list",
  "check-ignore",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "rev-parse",
  "show",
  "status",
]);

/** An install that only restores node_modules from the lockfile, changing no manifest. */
function lockfileInstall(command: string) {
  const [manager, operation, ...rest] = command.split(/\s+/u);
  const operands = rest.filter((word) => !word.startsWith("-"));
  const flags = new Set(rest.filter((word) => word.startsWith("-")).map((word) => word.split("=")[0]));
  if (manager === "npm") return operation === "ci" && operands.length === 0;
  if (operation !== "install" && operation !== "i") return false;
  if (operands.length) return false;
  return flags.has("--frozen-lockfile") || flags.has("--immutable");
}

/**
 * Shell variables that hold a scratch path this command made: `F=$(mktemp -d)`
 * or a path under $TMPDIR. Deleting there touches nothing Blame journals, and
 * nothing the user owns, unlike an arbitrary /tmp path on their machine.
 */
function scratchVariables(root: SgNode) {
  const names = new Set(["TMPDIR"]);
  for (const assignment of root.findAll({ rule: { kind: "variable_assignment" } })) {
    const [name, ...value] = assignment.text().split("=");
    if (name && temporaryPath.test(value.join("="))) names.add(name);
  }
  return names;
}

function scratchDeletion(command: string, scratch: Set<string>) {
  const [name, ...words] = command.split(/\s+/u);
  if (name !== "rm" && name !== "rmdir") return false;
  const operands = words.filter((word) => !word.startsWith("-")).map((word) => word.replace(/^["']|["']$/gu, ""));
  return operands.length > 0 && operands.every((operand) => {
    if (/(?:^|\/)\.\.(?:\/|$)/u.test(operand)) return false;
    const [, variable, rest] = /^\$\{?(\w+)\}?(\/.*)?$/u.exec(operand) ?? [];
    if (!variable || !scratch.has(variable)) return false;
    return variable !== "TMPDIR" || /^\/[^/]/u.test(rest ?? "");
  });
}

const temporaryPath = /^["']?\$\(\s*mktemp\b|^["']?\$\{?TMPDIR\}?\/[^/]/u;

function signalInspection(command: string) {
  const [name, option, ...signals] = command.split(/\s+/u);
  return (
    name === "kill" &&
    /^(?:-[lL]|--table|--list(?:=[\w+-]+)?)$/u.test(option ?? "") &&
    signals.every((signal) => /^\w+(?:[+-]\d+)?$/u.test(signal))
  );
}

function deniedGitCommand(command: string) {
  if (!/^git(?:\s|$)/u.test(command)) return false;
  command = command.replace(
    /\bgit(?:\s+(?:-C|--git-dir|--work-tree)(?:\s+|=)(?:'[^']*'|"[^"]*"|[^\s;|&]+))+\s+/gu,
    "git ",
  );
  if (/^git\s+--(?:version|help)\s*$/u.test(command)) return false;
  if (/\bgit\s+-/u.test(command)) return true;
  return [...command.matchAll(/\bgit\s+([a-z][\w-]*)([^;&|\n]*)/gu)].some(
    ([, operation, argumentsValue]) =>
      operation === "branch"
        ? argumentsValue?.trim() !== "--show-current"
        : !allowedGitCommands.has(operation ?? ""),
  );
}

function unmanagedViteCommand(command: string) {
  return (
    /^vite(?:\s|$)/u.test(command) &&
    !/^vite\s+(?:build|optimize|--help|--version)(?:\s|$)/u.test(command)
  );
}
