// The files a skill folder brings along (`references/`, `scripts/`,
// `assets/`), read for the model through the `skills` tool.
//
// The harness reads inside the workspace only, and a user-level skill lives
// elsewhere (`~/.claude/skills/<name>`). Rather than widen that boundary, the
// tool reads on this computer, as `read_attachment` does, and only inside the
// folder of a skill this conversation discovered: the folder and the file are
// resolved to their real paths first, so `..`, an absolute path elsewhere or
// a symbolic link pointing out of the folder all fail. Scripts are not run
// here: the model runs them by their full path with the run tool, under the
// conversation's usual approvals.

import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const maxBytes = 1024 * 1024;
const pageChars = 40_000;

/** Whether a skill folder holds anything but its `SKILL.md`. */
export async function hasSkillFiles(skillFile: string) {
  const names = await readdir(dirname(skillFile)).catch(() => []);
  return names.some((name) => name !== "SKILL.md" && !name.startsWith("."));
}

/**
 * A text file of a skill's folder, a page at a time. `file` is relative to
 * the folder (or an absolute path inside it). Every refusal is a sentence the
 * model reads.
 */
export async function readSkillFile(
  skillFile: string,
  file: string,
  offset = 0,
): Promise<string> {
  const folder = await realpath(dirname(skillFile)).catch(() => undefined);
  if (!folder) return "This skill's folder is gone.";
  const path = await realpath(resolve(folder, file)).catch(() => undefined);
  if (!path) return `File "${file}" not found in this skill's folder.`;
  const local = relative(folder, path);
  if (
    !local ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  )
    return "Only files inside the skill's own folder can be read.";
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return `"${file}" is not a file.`;
  if (info.size > maxBytes)
    return `"${local}" is larger than 1 MiB; run a script on it instead.`;
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(info.size);
    await handle.read(bytes, 0, info.size, 0);
  } finally {
    await handle.close();
  }
  if (bytes.subarray(0, 8192).includes(0))
    return `"${local}" is a binary file; read it with a script, not as text.`;
  const text = bytes.toString("utf8");
  const start = Math.max(0, Math.floor(offset));
  const page = text.slice(start, start + pageChars);
  const end = start + page.length;
  const more =
    end < text.length
      ? `\n[Truncated at character ${end} of ${text.length}; continue with offset ${end}.]`
      : "";
  return `<skill-file path="${local.split(sep).join("/")}">\n${page}${more}\n</skill-file>`;
}
