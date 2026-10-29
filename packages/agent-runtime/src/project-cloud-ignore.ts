import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

export type CloudPreviewIgnoreRule = { pattern: string; reason: string };

export const cloudPreviewIgnoreSchema = {
  type: "array",
  maxItems: 50,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["pattern", "reason"],
    properties: {
      pattern: { type: "string", minLength: 2, maxLength: 512 },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
} as const;

const begin = "# BEGIN BLAME GENERATED CLOUD EXCLUSIONS";
const end = "# END BLAME GENERATED CLOUD EXCLUSIONS";
const maximumControlBytes = 64 * 1024;

/** Generated rules use exact root paths; manual rules retain full Gitignore syntax. */
export function parseCloudPreviewIgnore(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("cloudPreviewIgnore must contain at most 50 rules");
  const patterns = new Set<string>();
  return value.map((item: unknown): CloudPreviewIgnoreRule => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("cloudPreviewIgnore rules must be objects");
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).some((key) => key !== "pattern" && key !== "reason"))
      throw new Error("Unknown cloudPreviewIgnore rule field");
    const { pattern, reason } = rule;
    if (typeof pattern !== "string" || !validGeneratedPattern(pattern))
      throw new Error(
        "cloudPreviewIgnore patterns must be exact rooted paths, optionally ending in /**",
      );
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 500 ||
      /[\r\n\0]/.test(reason)
    )
      throw new Error(
        "cloudPreviewIgnore rules need a single-line evidence-based reason",
      );
    if (patterns.has(pattern))
      throw new Error("Duplicate cloudPreviewIgnore pattern");
    patterns.add(pattern);
    return { pattern, reason: reason.trim() };
  });
}

function validGeneratedPattern(pattern: string) {
  const path = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  return (
    pattern.length <= 512 &&
    path.startsWith("/") &&
    !/[\r\n\0\\*?[\]{}!#]/.test(path) &&
    path
      .slice(1)
      .split("/")
      .every(
        (part) => part && part !== "." && part !== ".." && part.trim() === part,
      ) &&
    !["/.blameignore", "/.gitignore", "/.git"].includes(path)
  );
}

/** Replace only our marked block. Everything else is retained byte for byte. */
export function mergeProjectCloudIgnore(
  existing: string,
  rules: CloudPreviewIgnoreRule[],
) {
  parseCloudPreviewIgnore(rules);
  const lines = [...existing.matchAll(/[^\n]*(?:\n|$)/g)].filter(
    (line) => line[0],
  );
  const starts = lines.filter(
    (line) => line[0].replace(/\r?\n$/, "") === begin,
  );
  const ends = lines.filter((line) => line[0].replace(/\r?\n$/, "") === end);
  let manual = existing;
  if (starts.length || ends.length) {
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0]!.index! >= ends[0]!.index!
    )
      throw new Error(
        "Cannot update .blameignore: malformed generated block; manual rules were preserved",
      );
    manual =
      existing.slice(0, starts[0]!.index) +
      existing.slice(ends[0]!.index! + ends[0]![0].length);
  }
  if (!rules.length) return manual;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    begin,
    "# Updated by project analysis. Put manual rules below this block; they take precedence.",
    ...rules.flatMap(({ pattern, reason }) => [`# ${reason}`, pattern]),
    end,
    "",
  ].join(newline);
  return block + manual;
}

export async function readProjectCloudIgnore(root: string) {
  const path = join(root, ".blameignore");
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(".blameignore must be a regular file");
    if (info.size > maximumControlBytes)
      throw new Error(".blameignore exceeds 64 KiB");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Called once, after an accepted analysis, using the latest manual rules on disk. */
export async function updateProjectCloudIgnore(
  root: string,
  rules?: CloudPreviewIgnoreRule[],
) {
  if (rules === undefined) return;
  parseCloudPreviewIgnore(rules);
  for (const { pattern } of rules) {
    const directory = pattern.endsWith("/**");
    const path = join(
      root,
      directory ? pattern.slice(1, -3) : pattern.slice(1),
    );
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    )
      throw new Error(
        `Cloud exclusion does not match an existing ${directory ? "directory" : "file"}: ${pattern}`,
      );
  }
  const existing = await readProjectCloudIgnore(root);
  const next = mergeProjectCloudIgnore(existing ?? "", rules);
  if (next === (existing ?? "")) return;
  if (Buffer.byteLength(next) > maximumControlBytes)
    throw new Error("Generated .blameignore exceeds 64 KiB");
  await writeFileAtomic(join(root, ".blameignore"), next, { encoding: "utf8" });
}
