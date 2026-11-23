// Fetching, checking and installing a skill from GitHub for
// `blame_configure action=install_skill` (and checking one without writing
// anything, for `blame_inspect area=skills source=…`).
//
// A skill is instructions that join the agent's prompt, so the rules are:
// - nothing is written before the whole skill was fetched and `SKILL.md` was
//   checked; the skill goes into a staging folder, then is renamed into place;
// - files are copied as inert data (never made executable, never run), and
//   scripts among them are reported;
// - only github.com's API and raw.githubusercontent.com are fetched, plus one
//   https URL that names a `SKILL.md` file itself;
// - an existing skill is never overwritten.

import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const maxFiles = 40;
const maxFileBytes = 200 * 1024;
const maxTotalBytes = 1024 * 1024;
const maxDepth = 3;
const nameRule = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const scriptExtensions =
  /\.(?:sh|bash|zsh|py|rb|js|mjs|cjs|ts|pl|ps1|bat|cmd)$/i;

export type SkillFile = { path: string; data: Buffer };

export type SkillCandidate = {
  /** Where it came from, as the person approved it. */
  source: string;
  commit?: string;
  files: SkillFile[];
};

export type CheckedSkill = {
  name: string;
  description: string;
  files: string[];
  scripts: string[];
  /** The first lines of the instructions, to read before installing. */
  preview: string;
  bytes: number;
};

type Fetch = typeof fetch;

type GithubSource = { owner: string; repo: string; ref?: string; path: string };

/** `owner/repo[/path]`, or a github.com tree, blob or raw URL. */
export function parseGithubSource(source: string): GithubSource | undefined {
  const text = source.trim();
  const short = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(text);
  if (short && !text.includes(":"))
    return {
      owner: short[1]!,
      repo: short[2]!.replace(/\.git$/, ""),
      path: trimSlashes(short[3] ?? ""),
    };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:") return undefined;
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4)
    return {
      owner: parts[0]!,
      repo: parts[1]!,
      ref: parts[2],
      path: dirname(parts.slice(3).join("/")).replace(/^\.$/, ""),
    };
  if (url.hostname !== "github.com" || parts.length < 2) return undefined;
  const [owner, repo, kind, ref, ...rest] = parts;
  const base = { owner: owner!, repo: repo!.replace(/\.git$/, "") };
  if (!kind) return { ...base, path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) return undefined;
  const path = rest.join("/");
  return {
    ...base,
    ref,
    path:
      kind === "blob" && /(?:^|\/)SKILL\.md$/.test(path)
        ? dirname(path).replace(/^\.$/, "")
        : path,
  };
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

/** Fetches the skill the source names; throws a message the model can act on. */
export async function fetchSkill(
  source: string,
  fetchImplementation: Fetch = fetch,
): Promise<SkillCandidate> {
  const github = parseGithubSource(source);
  if (!github) return fetchSingleFile(source, fetchImplementation);
  const get = githubGetter(fetchImplementation);
  // Everything is read at one commit, so the skill cannot change midway.
  const commit = await get.commit(github).catch(() => undefined);
  const pinned = commit ? { ...github, ref: commit } : github;
  const root = await locateSkill(pinned, get);
  const files: SkillFile[] = [];
  let total = 0;
  const walk = async (path: string, relative: string, depth: number) => {
    const listing = await get.contents(pinned, path);
    if (!Array.isArray(listing)) throw new Error(`${path} is not a folder.`);
    for (const entry of listing) {
      if (entry.name.startsWith(".git")) continue;
      const here = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === "dir") {
        if (depth >= maxDepth)
          throw new Error("The skill nests folders too deeply.");
        await walk(entry.path, here, depth + 1);
      } else if (entry.type === "file") {
        if (files.length >= maxFiles)
          throw new Error(`The skill has more than ${maxFiles} files.`);
        if (entry.size > maxFileBytes)
          throw new Error(`${here} is larger than ${maxFileBytes / 1024} KB.`);
        total += entry.size;
        if (total > maxTotalBytes)
          throw new Error("The skill is larger than 1 MB.");
        files.push({ path: here, data: await get.file(entry.download_url) });
      }
    }
  };
  await walk(root.path, "", 0);
  return {
    source: `github:${github.owner}/${github.repo}${root.path ? `/${root.path}` : ""}`,
    ...(commit ? { commit } : {}),
    files,
  };
}

type Entry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  download_url: string;
};

function githubGetter(fetchImplementation: Fetch) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "Blame",
  };
  const json = async (url: string) => {
    const response = await fetchImplementation(url, { headers });
    if (response.status === 404)
      throw new Error(
        "GitHub has no such repository or path (or it is private).",
      );
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub refused the request (rate limit); try again in a few minutes.",
      );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    return (await response.json()) as unknown;
  };
  return {
    async contents(source: GithubSource, path: string) {
      const query = source.ref ? `?ref=${encodeURIComponent(source.ref)}` : "";
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      return (await json(
        `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${encoded}${query}`,
      )) as Entry[] | Entry;
    },
    async commit(source: GithubSource) {
      const ref = source.ref ?? "HEAD";
      const value = (await json(
        `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
      )) as { sha?: unknown };
      return typeof value.sha === "string" ? value.sha : undefined;
    },
    async file(url: string) {
      if (new URL(url).hostname !== "raw.githubusercontent.com")
        throw new Error(
          "GitHub pointed at a file outside raw.githubusercontent.com.",
        );
      const response = await fetchImplementation(url, {
        headers: { "user-agent": "Blame" },
      });
      if (!response.ok)
        throw new Error(`GitHub answered ${response.status} for a file.`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

// The folder with the SKILL.md: the one named, or the only skill under it.
async function locateSkill(
  source: GithubSource,
  get: ReturnType<typeof githubGetter>,
) {
  const listing = await get.contents(source, source.path);
  if (!Array.isArray(listing))
    throw new Error("Name the skill's folder, not a single file.");
  if (
    listing.some((entry) => entry.type === "file" && entry.name === "SKILL.md")
  )
    return { path: source.path };
  const candidates: string[] = [];
  for (const folder of [source.path, join(source.path, "skills")]) {
    const inner =
      folder === source.path
        ? listing
        : await get.contents(source, folder).catch((): Entry[] => []);
    if (!Array.isArray(inner)) continue;
    for (const entry of inner)
      if (entry.type === "dir") candidates.push(entry.path);
  }
  const found: string[] = [];
  for (const path of candidates.slice(0, 30)) {
    const inner = await get.contents(source, path).catch((): Entry[] => []);
    if (
      Array.isArray(inner) &&
      inner.some((entry) => entry.name === "SKILL.md")
    )
      found.push(path);
  }
  if (found.length === 1) return { path: found[0]! };
  throw new Error(
    found.length
      ? `Several skills here: ${found.join(", ")}. Name one: owner/repo/<path>.`
      : "There is no SKILL.md here. A skill is a folder with a SKILL.md file.",
  );
}

// One SKILL.md that lives on GitHub's own file hosts (a raw file or a gist),
// not any address a page or a README suggests.
const singleFileHosts = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);

async function fetchSingleFile(
  source: string,
  fetchImplementation: Fetch,
): Promise<SkillCandidate> {
  const refusal =
    "Give a GitHub source (owner/repo or owner/repo/path, or a github.com URL).";
  let url: URL;
  try {
    url = new URL(source.trim());
  } catch {
    throw new Error(refusal);
  }
  if (
    url.protocol !== "https:" ||
    !singleFileHosts.has(url.hostname) ||
    !/\/SKILL\.md$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(refusal);
  const response = await fetchImplementation(url, {
    headers: { "user-agent": "Blame" },
  });
  if (!response.ok) throw new Error(`${url.host} answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxFileBytes)
    throw new Error(`The file is larger than ${maxFileBytes / 1024} KB.`);
  return {
    source: url.origin + url.pathname,
    files: [{ path: "SKILL.md", data }],
  };
}

/** Checks a fetched skill; throws why it is refused. Writes nothing. */
export function checkSkill(candidate: SkillCandidate): CheckedSkill {
  for (const file of candidate.files) {
    const parts = file.path.split("/");
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      parts.some((part) => part === ".." || part === "." || part === "") ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f]/.test(file.path)
    )
      throw new Error(
        `The skill has an unsafe file path: ${JSON.stringify(file.path)}.`,
      );
  }
  const skillFile = candidate.files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new Error("The skill has no SKILL.md at its root.");
  const text = skillFile.data.toString("utf8").replace(/^﻿/u, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match)
    throw new Error(
      "SKILL.md needs a front matter (--- name and description ---).",
    );
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    throw new Error(
      `SKILL.md's front matter is not valid YAML: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
    );
  }
  const fields = (data && typeof data === "object" ? data : {}) as Record<
    string,
    unknown
  >;
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description =
    typeof fields.description === "string" ? fields.description.trim() : "";
  if (!nameRule.test(name))
    throw new Error(
      "SKILL.md's name must be 1-64 letters, digits, dots, dashes or underscores.",
    );
  if (!description) throw new Error("SKILL.md needs a description.");
  const body = match[2]!.trim();
  if (!body)
    throw new Error("SKILL.md has no instructions after its front matter.");
  return {
    name,
    description: description.slice(0, 300),
    files: candidate.files.map((file) => file.path),
    scripts: candidate.files
      .map((file) => file.path)
      .filter((path) => scriptExtensions.test(path)),
    preview: body.split("\n").slice(0, 12).join("\n").slice(0, 800),
    bytes: candidate.files.reduce((sum, file) => sum + file.data.length, 0),
  };
}

/** Where a skill of this scope goes: the user's folder, or the project's. */
export function skillsFolder(
  scope: "user" | "project",
  workspaceRoot: string,
  home = homedir(),
) {
  return scope === "project"
    ? join(workspaceRoot, ".claude", "skills")
    : join(home, ".agents", "skills");
}

/** Writes a checked skill into `folder/<name>`; never over an existing one. */
export async function writeSkill(
  folder: string,
  checked: CheckedSkill,
  candidate: SkillCandidate,
) {
  const target = join(folder, checked.name);
  const existing = await readdir(target).then(
    () => true,
    () => false,
  );
  if (existing)
    throw new Error(
      `A skill folder named ${checked.name} already exists at ${target}. It is not replaced: the person removes it first if they want the new one.`,
    );
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(join(folder, `.${checked.name}-installing-`));
  try {
    for (const file of candidate.files) {
      const path = join(staging, file.path);
      await mkdir(dirname(path), { recursive: true });
      // Plain data: no executable bit, whatever the file was upstream.
      await writeFile(path, file.data, { mode: 0o644 });
    }
    await writeFile(
      join(staging, ".blame-source.json"),
      `${JSON.stringify({ source: candidate.source, commit: candidate.commit, installedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o644 },
    );
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}
