import { posix } from "node:path";
import { readExistingFiles, run } from "../workspace-runtime.ts";
import { relativeWorkspacePath } from "../workspace-env.ts";
import type { EnvDeclaration } from "./environment-resolver.ts";

// The environment variables a project's code says it needs, read from the
// schemas apps validate at startup: AdonisJS `start/env.ts`, t3-env's
// `createEnv` and a zod object parsed from `process.env`. A required key the
// preview lacks fails the start before any container runs, with the key's
// name, instead of a crashed container later.

export type DeclaredEnvironment = Record<string, EnvDeclaration[]>;

const maximumFiles = 24;

/** Declarations of every env schema in a worktree, by package directory. */
export async function worktreeEnvDeclarations(
  worktree: string,
): Promise<DeclaredEnvironment> {
  const paths = await envSchemaFiles(worktree).catch(() => []);
  if (!paths.length) return {};
  const contents = await readExistingFiles(paths);
  const declared: DeclaredEnvironment = {};
  for (const path of paths) {
    const content = contents[path];
    if (typeof content !== "string") continue;
    const parsed = parseEnvDeclarations(
      relativeWorkspacePath(worktree, path),
      content,
    );
    if (!parsed) continue;
    declared[parsed.directory] = [
      ...(declared[parsed.directory] ?? []),
      ...parsed.declarations,
    ];
  }
  return declared;
}

async function envSchemaFiles(worktree: string) {
  const { stdout } = await run(
    "find",
    [
      worktree,
      "(",
      ...["node_modules", ".git", ".blame", "dist", "build", ".next"].flatMap(
        (name, index) => [...(index ? ["-o"] : []), "-name", name],
      ),
      ")",
      "-prune",
      "-o",
      "-type",
      "f",
      "(",
      "-name",
      "env.ts",
      "-o",
      "-name",
      "env.mts",
      "-o",
      "-name",
      "env.mjs",
      "-o",
      "-name",
      "env.js",
      "-o",
      "-path",
      "*/env/server.ts",
      ")",
      "-print",
    ],
    { cwd: worktree },
  );
  return stdout.split("\n").filter(Boolean).slice(0, maximumFiles);
}

/**
 * The keys one schema file declares, and the package directory they belong
 * to; undefined when the file is not an env schema Blame understands.
 */
export function parseEnvDeclarations(path: string, content: string) {
  if (
    /(?:^|\/)start\/env\.[cm]?[jt]s$/.test(path) &&
    /Env\.create\s*\(/.test(content)
  )
    return {
      directory: packageDirectory(path, "start"),
      declarations: schemaEntries(content, /Env\.schema\./).map(
        ({ key, chain }) => ({
          key,
          required: !/\.optional\b/.test(chain),
          // AdonisJS rejects an empty value like a missing one.
          rejectsEmpty: true,
          file: path,
        }),
      ),
    };
  const t3 = /createEnv\s*\(/.test(content) && /@t3-oss\/env/.test(content);
  const zod =
    /\bz\.object\s*\(/.test(content) && /process\.env\b/.test(content);
  if (!t3 && !zod) return undefined;
  return {
    directory: packageDirectory(path, "src"),
    declarations: schemaEntries(content, /\bz\s*\.|\bz\b/).map(
      ({ key, chain }) => ({
        key,
        required: !/\.(?:optional|default|catch)\s*\(|\.nullish\s*\(/.test(
          chain,
        ),
        rejectsEmpty: false,
        file: path,
      }),
    ),
  };
}

// `KEY: <schema chain>` entries; a chain can span lines, each starting
// with a dot.
function schemaEntries(content: string, schema: RegExp) {
  const lines = content.split(/\r?\n/);
  const entries: Array<{ key: string; chain: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*["']?([A-Z][A-Z0-9_]*)["']?\s*:\s*(.*)$/.exec(
      lines[index]!,
    );
    if (!match || !schema.test(match[2]!)) continue;
    let chain = match[2]!;
    while (index + 1 < lines.length && /^\s*\./.test(lines[index + 1]!))
      chain += lines[++index]!.trim();
    if (!entries.some(({ key }) => key === match[1])) {
      entries.push({ key: match[1]!, chain });
    }
  }
  return entries;
}

// `packages/api/start/env.ts` belongs to `packages/api`; `apps/web/src/env.ts`
// to `apps/web`; `env.ts` at the root to the root.
function packageDirectory(path: string, folder: string) {
  const parts = posix.dirname(path).split("/");
  const at = parts.lastIndexOf(folder);
  const directory = (at >= 0 ? parts.slice(0, at) : parts)
    .filter((part) => part && part !== ".")
    .join("/");
  return directory || ".";
}
