// What a failed preview or MCP server usually means, and the step that
// fixes it, read from its log or error. Plain patterns on purpose: the
// answer names a repair action of `blame_repair` or the step only the
// person can take, so the model does not have to guess one.

export type Diagnosis = {
  /** A short name for the failure. */
  cause: string;
  /** The next step, in the tools' own words. */
  next: string;
};

type Rule = { pattern: RegExp } & Diagnosis;

const previewRules: Rule[] = [
  {
    pattern:
      /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|lockfile.*(?:out of date|not up to date|mismatch)|npm error.*package-lock/i,
    cause: "the lockfile does not match package.json",
    next: "Update the lockfile in the project (run the package manager's install in the workspace), then blame_repair action=refresh_dependencies.",
  },
  {
    pattern:
      /Cannot find module|MODULE_NOT_FOUND|Module not found|ERR_MODULE_NOT_FOUND/i,
    cause: "a dependency is missing in the preview",
    next: "blame_repair action=refresh_dependencies; if the module is not in package.json, add it first.",
  },
  {
    pattern:
      /Cannot connect to the Docker daemon|docker.*not running|Is the docker daemon running/i,
    cause: "the runtime's containers are not running",
    next: "blame_inspect area=runtime; if the VM is stopped, blame_repair action=start_runtime.",
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    cause: "the port is already taken",
    next: "blame_repair action=restart_preview; if it repeats, another process holds the port: name it to the person.",
  },
  {
    pattern:
      /ECONNREFUSED.*(?:5432|3306|6379|27017)|database.*(?:refused|does not exist|unavailable)|connection to server.*failed/i,
    cause: "the database is not reachable",
    next: "blame_repair action=restart_preview; if the setup has no database service, repair_preview_initialization (stories) can add one.",
  },
  {
    pattern:
      /(?:environment variable|env var|process\.env\.)[^\n]*(?:missing|not set|undefined|required)|(?:missing|required)[^\n]*environment variable|is not set\b/i,
    cause: "an environment variable is missing",
    next: "preview_environment action=list to see which, then action=request for the one only the person can give. Never ask for the value in chat.",
  },
  {
    pattern: /heap out of memory|ENOMEM|\bKilled\b|OOMKilled|exit code 137/i,
    cause: "the preview ran out of memory",
    next: "blame_repair action=restart_preview once; if it repeats, tell the person the runtime needs more memory (Settings → Desktop → Runtime).",
  },
  {
    pattern:
      /Syntax ?Error|Unexpected token|Failed to compile|Build error|TS\d{4}:/i,
    cause: "the project's own code does not compile",
    next: "Fix the error shown in the excerpt in the code; Blame's tools cannot repair it.",
  },
  {
    pattern: /ENOSPC|no space left/i,
    cause: "the disk is full",
    next: "Tell the person: free disk space on this computer, then blame_repair action=restart_preview.",
  },
];

const mcpRules: Rule[] = [
  {
    pattern: /ENOENT|not found|command not found|spawn .* ENOENT/i,
    cause: "the server's command is not installed here",
    next: "Check the program exists on this computer (node, npx, uvx…); the person installs what it needs, or remove the server.",
  },
  {
    pattern:
      /401|403|unauthori[sz]ed|forbidden|invalid.*(?:token|api[_ ]?key)|authorization/i,
    cause: "the server refuses the credentials",
    next: "blame_repair action=hand_over where=mcp: only the person can authorize the server or paste its key.",
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|getaddrinfo/i,
    cause: "the server is not reachable",
    next: "Check the URL and the network; for a local server, start it, then blame_repair action=reconnect_mcp.",
  },
  {
    pattern:
      /timed? ?out|did not (?:start|respond)|Connection closed|MCP error -32000/i,
    cause: "the server started and stopped or did not answer",
    next: "blame_repair action=reconnect_mcp once; if it fails again the server's own command is failing: run it in a shell to read its error.",
  },
];

/** The cause and step for a failure text, if a known pattern matches. */
export function diagnosePreview(text: string): Diagnosis | undefined {
  return diagnose(previewRules, text);
}

export function diagnoseMcp(text: string): Diagnosis | undefined {
  return diagnose(mcpRules, text);
}

function diagnose(rules: Rule[], text: string): Diagnosis | undefined {
  const rule = rules.find(({ pattern }) => pattern.test(text));
  return rule ? { cause: rule.cause, next: rule.next } : undefined;
}
