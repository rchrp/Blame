import { boundedDiagnostic } from "./light-diagnostic.js";
import { dependencyManifestSections } from "./light-dependencies.js";
import type { LightToolResult } from "./light-contracts.js";
import { recordValue } from "./light-navigation.js";
import { literalShellStatements } from "./shell-words.js";
import { isValidationKind } from "./task-catalog.js";
import type { WorkspaceFiles } from "./workspace-files.js";

/** How a failed command is presented: who must act, and what to try next. */
export type FailureAssessment = {
  category: "code" | "command" | "environment";
  recovery: string;
};

export function failedCommandResult(
  exitCode: number | undefined,
  output: string,
  failure: FailureAssessment,
  command?: string,
): LightToolResult<unknown> {
  const filter = exitCode === 1 && !output.trim() && command ? finalFilter(command) : undefined;
  if (filter)
    return {
      status: "blocked",
      category: "command",
      message: `Command exited with code 1: its last stage, \`${filter}\`, selected no line, so nothing was printed. That exit code is ${filter}'s, not the earlier commands'.`,
      recovery: "Rerun without the final filter or with a broader pattern, or write the output to a file and search that file.",
    };
  const diagnostic =
    boundedDiagnostic(output) || "No diagnostic output was produced.";
  return {
    status: "blocked",
    category: failure.category,
    message: `Command exited with code ${exitCode ?? "unknown"}.\n${diagnostic}`,
    recovery: failure.recovery,
  };
}

/** The grep or rg that ends a pipeline, whose "no line matched" status hides everything before it. */
function finalFilter(command: string) {
  const statements = literalShellStatements(command);
  const last = statements?.at(-1)?.pipeline;
  if (last) {
    const name = last.at(-1)?.words[0]?.value;
    return last.length > 1 && name && filters.has(name) ? name : undefined;
  }
  // Not a literal command line (variables, assignments): read it without its quoted words.
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, "''");
  return /\|\s*(e?grep|fgrep|rg)\b[^|;&]*$/u.exec(unquoted)?.[1];
}

const filters = new Set(["egrep", "fgrep", "grep", "rg"]);

export async function commandFailureAssessment(
  output: string,
  files: WorkspaceFiles,
  taskKind?: string,
  exitCode?: number,
): Promise<FailureAssessment> {
  const missingEnvironment = missingEnvironmentVariables(output);
  if (missingEnvironment.length)
    return environmentVariableFailure(missingEnvironment);
  const missingEntryModule = missingPythonEntryModule(output);
  if (missingEntryModule) return pythonEntryModuleFailure(missingEntryModule);
  const missing = missingDependencyNames(output);
  if (missing.length) {
    const declared = await declaredDependencies(files);
    if (missing.some((name) => declared.has(name)))
      return environmentDependencyFailure();
    return codeFailure();
  }
  // POSIX sh/dash omits "command" in its missing-executable diagnostic.
  // Require its shell-prefixed line and exit 127, not arbitrary "not found" text.
  if (exitCode === 127 && /^(?:\/[^\s:]+\/)?(?:sh|dash):\s*(?:line\s+)?(?:\d+:\s*)?[^:\r\n]+:\s*not found\s*$/mu.test(output))
    return environmentFailure();
  if (environmentDiagnostic(output)) return environmentFailure();
  return isValidationKind(taskKind) ? codeFailure() : commandFailure();
}

function missingPythonEntryModule(output: string) {
  if (/Traceback \(most recent call last\):/u.test(output)) return undefined;
  return /(?:^|\n)[^\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?: No module named ([\w.]+)\s*$/u.exec(
    output,
  )?.[1];
}

function pythonEntryModuleFailure(module: string): FailureAssessment {
  return {
    category: "environment",
    recovery: `Python cannot start module ${module} in this interpreter. Check the project environment and module name; install the required tool with the project's package manager if needed, then rerun the command.`,
  };
}

function environmentDiagnostic(output: string) {
  return /(?:\bEAI_AGAIN\b|\bEACCES\b|\bECONN(?:REFUSED|RESET)?\b|\bENETUNREACH\b|\bENOSPC\b|\bENOENT\b|\bENOTFOUND\b|\bEPERM\b|\bETIMEDOUT\b|\bELOOP\b|\bP1001\b|broken (?:symbolic )?link|can't reach database server|command not found|connection refused|could not connect to server|dangling symlink|failed to connect|managed preview.*(?:failed|unavailable)|no space left on device|no such file or directory|not recognized as an internal or external command|PACKAGE_MANAGER_UNAVAILABLE|permission denied|preview (?:container|runtime).*(?:failed|unavailable)|\.prisma\/client)/iu.test(
    output,
  );
}

function missingEnvironmentVariables(output: string) {
  const expressions = [
    /Cannot resolve environment variable:\s*([A-Z][A-Z0-9_]*)/giu,
    /Environment variable not found:\s*([A-Z][A-Z0-9_]*)/giu,
    /Missing environment variable:\s*([A-Z][A-Z0-9_]*)/giu,
  ];
  return [
    ...new Set(
      expressions.flatMap((expression) =>
        [...output.matchAll(expression)].map((match) => match[1]!),
      ),
    ),
  ];
}

function missingDependencyNames(output: string) {
  const expressions = [
    /Cannot find (?:module|package)\s+['"`]([^'"`]+)['"`]/giu,
    /Module not found:\s*(?:Error:\s*)?Can't resolve\s+['"`]([^'"`]+)['"`]/giu,
  ];
  return expressions
    .flatMap((expression) => [...output.matchAll(expression)])
    .flatMap((match) => {
      const name = dependencyName(match[1] ?? "");
      return name ? [name] : [];
    });
}

function dependencyName(value: string) {
  const installed = installedDependencyName(value);
  if (installed) return installed;
  if (
    !value ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.includes("\\")
  )
    return undefined;
  const segments = value.split("/");
  return value.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function installedDependencyName(value: string) {
  const portable = value.replaceAll("\\", "/");
  const installed = portable.split("/node_modules/").at(-1);
  if (!installed || installed === portable) return undefined;
  const segments = installed.split("/");
  return installed.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

async function declaredDependencies(files: WorkspaceFiles) {
  const names = new Set<string>();
  const snapshot = await files.snapshot();
  const manifests = snapshot.files.filter((path) =>
    path.endsWith("package.json"),
  );
  for (const path of manifests.slice(0, 200))
    for (const name of await manifestDependencies(files, path)) names.add(name);
  return names;
}

async function manifestDependencies(files: WorkspaceFiles, path: string) {
  try {
    const content = (await files.read(path)).content.toString("utf8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    return dependencyManifestSections.flatMap((key) =>
      Object.keys(recordValue(manifest[key])),
    );
  } catch {
    return [];
  }
}

function codeFailure(): FailureAssessment {
  return {
    category: "code",
    recovery:
      "Fix the reported project error before running the relevant validation again.",
  };
}

function environmentDependencyFailure(): FailureAssessment {
  return {
    category: "environment",
    recovery:
      "Use the dependency operation once if the declared installation is incomplete; do not edit manifests or copy files through the shell.",
  };
}

function environmentVariableFailure(names: string[]): FailureAssessment {
  return {
    category: "environment",
    recovery: `Required runtime variable${names.length > 1 ? "s" : ""} ${names.join(", ")} ${names.length > 1 ? "are" : "is"} unavailable. Keep configuration environment-based; do not add credentials, localhost URLs, or source fallbacks. Continue with validations that do not require these values and report this validation unavailable.`,
  };
}

function environmentFailure(): FailureAssessment {
  return {
    category: "environment",
    recovery:
      "Inspect the reported environment problem and recover the required tool, path, or service through the available project operations before retrying.",
  };
}

export function commandFailure(): FailureAssessment {
  return {
    category: "command",
    recovery:
      "Inspect the command output and adjust the command or its prerequisites before retrying.",
  };
}
