// Rewrites that make a manifest command behave the same in every container:
// node images ship corepack but no pnpm binary, `npm install` must not
// rewrite the project's lockfile, and the host user id means nothing inside
// a container. They apply when the plan is compiled, so local and cloud
// previews run the same command.

export function normalizedLaunchCommand(command: string) {
  return withNonMutatingNpmInstalls(
    withCorepackPnpm(withoutNumericSuUser(command)),
  );
}

/** A literal POSIX shell argument, including embedded quotes and newlines. */
export function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

// Package managers skip prompts and progress bars when CI is set.
export function launchEnvironment(
  command: string | undefined,
  environment: Record<string, string>,
) {
  if (!command || "CI" in environment || !installsPackages(command)) {
    return environment;
  }
  return { ...environment, CI: "true" };
}

export function installsPackages(command: string) {
  return /\b(?:pnpm|npm|yarn|bun)\s+(?:install|ci)\b/.test(command);
}

function withCorepackPnpm(command: string) {
  const rewritten = command
    .replace(
      /\bcorepack\s+enable\s*&&\s*/g,
      "(corepack enable 2>/dev/null || true) && ",
    )
    .replace(/(?<!corepack)(^|[\s;&|(])pnpm(?=\s|$)/g, "$1corepack pnpm");
  if (
    !/\bcorepack\s+pnpm\b/.test(rewritten) ||
    /\bcorepack\s+enable\b/.test(rewritten)
  ) {
    return rewritten;
  }
  return `(corepack enable 2>/dev/null || true) && ${rewritten}`;
}

function withNonMutatingNpmInstalls(command: string) {
  return command.replace(
    /(^|[\s;&|"'`(])npm\s+install\b([^\n;&|"'`]*)/g,
    (match, prefix: string, args: string) => {
      const tokens = npmTokens(args.trim());
      if (tokens.includes("--no-package-lock")) return match;
      if (hasPackageArguments(tokens)) return match;
      const options = args.trim() ? ` ${args.trim()}` : "";
      const separator = /\s$/.test(args) ? " " : "";
      return `${prefix}npm install --no-package-lock${options}${separator}`;
    },
  );
}

function hasPackageArguments(tokens: string[]) {
  return tokens.some(
    (token, index) =>
      !token.startsWith("-") && !npmOptionTakesValue(tokens[index - 1] ?? ""),
  );
}

function npmTokens(options: string): string[] {
  return options.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) ?? [];
}

function npmOptionTakesValue(option: string) {
  return [
    "--cache",
    "--prefix",
    "--registry",
    "--userconfig",
    "--workspace",
    "--workspace-root",
    "-w",
    "-C",
  ].includes(option.split("=")[0] ?? "");
}

function withoutNumericSuUser(command: string) {
  return command.replace(
    /\bsu\s+-s\s+\/bin\/bash\s+-c\s+((['"])(?:(?!\2).)+\2)\s+(['"])#\$\{BLAME_HOST_UID\}\3/g,
    "bash -lc $1",
  );
}
