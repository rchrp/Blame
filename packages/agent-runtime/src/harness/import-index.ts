import { posix } from "node:path";
import ts from "typescript";
import { parseEntry, uses, type Entry } from "./import-index-parse.js";
import { sha256 } from "./light-identity.js";
import type { WorkspaceFiles, WorkspaceSnapshot } from "./workspace-files.js";

// A cheap workspace import graph for JS/TS: per file, its import and
// re-export specifiers with the names they bind, resolved to workspace files.
// It answers "who uses this file's exports, where" without a compiler program.

type Step = { file: string; name: string };
type Json = Record<string, unknown>;
type PathConfig = { paths?: Record<string, unknown>; pathsBase?: string; baseUrl?: string };
export type BriefLinksOptions = {
  /** Maximum length of the result, in characters (default 200). */
  budget?: number;
  /** A snapshot the caller already took for this read; saves taking another. */
  snapshot?: WorkspaceSnapshot;
};

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const indexNames = ["index.ts", "index.tsx", "index.mts", "index.js", "index.jsx", "index.mjs"];
const jsToTs: Record<string, string[]> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};
const conditionOrder = ["source", "types", "typings", "import", "module", "default", "node", "require"];
const generatedDirectories = new Set(["generated", "__generated__", ".adonisjs"]);
const coldBuildWaitMs = 2_500;
const maxIndexedBytes = 1_000_000;
const sitesPerExport = 3;
const manyUsers = 6;
const separator = " · ";

export class ImportIndex {
  private readonly files: WorkspaceFiles;
  private readonly tokens = new Map<string, string>();
  private readonly hashes = new Map<string, string>();
  private readonly entries = new Map<string, Entry>();
  private readonly present = new Set<string>();
  private readonly configs = new Map<string, Json>();
  private head?: string;
  private graph?: Graph;
  private ready = false;
  private building?: Promise<void>;
  private buildDeadline = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(files: WorkspaceFiles) {
    this.files = files;
  }

  /** At most `budget` chars (default 200), or undefined when there is nothing useful. Deterministic for a given workspace content. */
  async briefLinks(path: string, content: Buffer, focus: ReadonlySet<string>,
    signal?: AbortSignal, options: BriefLinksOptions = {}): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (!isSourcePath(path)) return undefined;
    let target: string;
    try { target = this.files.normalizePath(path); } catch { return undefined; }
    let fresh = false;
    if (!this.ready) {
      if (!this.building) {
        this.buildDeadline = Date.now() + coldBuildWaitMs;
        this.building = this.exclusive(async () => {
          await this.refresh(options.snapshot ?? await this.files.snapshot());
          this.ready = true;
        }).catch(() => { this.building = undefined; });
      }
      if (!await settlesWithin(this.building, this.buildDeadline - Date.now(), signal) || !this.ready)
        return undefined;
      fresh = true;
    }
    // Links are an extra on a read: only an abort fails the call.
    return this.exclusive(async () => {
      try {
        if (!fresh) await this.refresh(options.snapshot ?? await this.files.snapshot(signal), signal);
        if (this.tokens.has(target)) this.update(target, content);
        return this.render(target, focus, options.budget ?? 200);
      } catch {
        signal?.throwIfAborted();
        return undefined;
      }
    });
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Brings the index to the snapshot, reading and reparsing only paths whose
  // per-file state changed (content hash for changed files, HEAD otherwise).
  private async refresh(snapshot: WorkspaceSnapshot, signal?: AbortSignal) {
    const head = snapshot.revision.base_commit;
    const states = new Map(snapshot.fileStates.map(({ path, hash }) => [path, hash]));
    const committed = this.head && head && this.head !== head
      ? new Set(await this.files.committedChanges(this.head, head)) : undefined;
    const next = new Map<string, string>();
    for (const path of snapshot.files)
      if (isSourcePath(path) || isConfigPath(path)) next.set(path, states.get(path) ?? `head:${head ?? ""}`);
    for (const path of [...this.tokens.keys()]) if (!next.has(path)) this.remove(path);
    const dirty: string[] = [];
    for (const [path, token] of next) {
      const previous = this.tokens.get(path);
      if (previous === token) continue;
      if (committed && previous?.startsWith("head:") && token.startsWith("head:") && !committed.has(path))
        this.tokens.set(path, token);
      else dirty.push(path);
    }
    // Workers stop between files on abort, so none outlives this call.
    await eachLimit(dirty, 32, async (path) => {
      if (signal?.aborted) return;
      let content: Buffer | undefined;
      try { content = (await this.files.read(path)).content; } catch { content = undefined; }
      if (content) this.update(path, content);
      else this.remove(path);
      this.tokens.set(path, next.get(path)!);
    });
    signal?.throwIfAborted();
    this.head = head;
  }

  private update(path: string, content: Buffer) {
    const hash = sha256(content);
    if (this.hashes.get(path) === hash) return;
    this.hashes.set(path, hash);
    if (isConfigPath(path)) {
      const json = parseJson(path, content.toString("utf8"));
      if (json) this.configs.set(path, json);
      else this.configs.delete(path);
      this.graph = undefined;
      return;
    }
    if (!isSourcePath(path)) return;
    const structural = !this.present.has(path);
    this.present.add(path);
    const previous = this.entries.get(path);
    if (previous) this.graph?.unlink(path, previous);
    const entry = indexable(path, content) ? parseEntry(path, content.toString("utf8"), hash) : undefined;
    if (entry) this.entries.set(path, entry);
    else this.entries.delete(path);
    if (structural) this.graph = undefined;
    else if (entry) this.graph?.link(path, entry);
  }

  private remove(path: string) {
    this.tokens.delete(path);
    this.hashes.delete(path);
    this.configs.delete(path);
    this.present.delete(path);
    this.entries.delete(path);
    this.graph = undefined;
  }

  private render(path: string, focus: ReadonlySet<string>, budget: number) {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    const graph = this.graph ??= new Graph(this.entries, this.present, this.configs);
    const names = (files: string[]) => files.map((file) => graph.display(file));
    if (isTestPath(path)) return listVariants("subject", names(this.subjects(graph, path, entry)), 2)
      .find((variant) => variant.length <= budget);
    // The tests segment comes last but keeps its room: exports fill the rest.
    const tests = listVariants("tests", names(this.tests(graph, path)), 2)
      .find((variant) => variant.length <= budget);
    const room = tests ? budget - tests.length - separator.length : budget;
    let text = "";
    for (const variants of this.exportVariants(graph, path, entry, focus)) {
      const fitted = variants.map((variant) => text ? `${text}${separator}${variant}` : variant)
        .find((candidate) => candidate.length <= room);
      if (!fitted) break;
      text = fitted;
    }
    return [text, tests].filter(Boolean).join(separator) || undefined;
  }

  private exportVariants(graph: Graph, path: string, entry: Entry, focus: ReadonlySet<string>) {
    const closure = new Set([path]);
    for (const file of closure)
      for (const barrel of graph.reexporters.get(file) ?? []) if (closure.size < 500) closure.add(barrel);
    const users = new Map<string, Map<string, number>>();
    for (const module of closure) for (const importer of graph.importers.get(module) ?? []) {
      // Tests get their own segment.
      if (importer === path || isTestPath(importer)) continue;
      const resolved = graph.resolved(importer);
      for (const record of this.entries.get(importer)?.imports ?? []) {
        if (resolved.get(record.spec) !== module) continue;
        for (const binding of record.bindings) for (const [name, line] of uses(binding)) {
          const hit = graph.trace(module, name).find((step) => step.file === path);
          if (!hit || graph.kind(path, hit.name) === "type") continue;
          const sites = users.get(hit.name) ?? new Map<string, number>();
          users.set(hit.name, sites);
          sites.set(importer, Math.min(sites.get(importer) ?? line, line));
        }
      }
    }
    const order = new Map(entry.order.map((name, index) => [name, index]));
    const label = (name: string) => name === "default" ? entry.defaultName ?? name : name;
    const focused = (name: string) => focus.has(name) || focus.has(label(name)) ? 0 : 1;
    return [...users].sort(([a, left], [b, right]) => focused(a) - focused(b) ||
      left.size - right.size || (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || compare(a, b))
      .map(([name, sites]) => siteVariants(label(name), [...sites].sort(([a], [b]) => compare(a, b))
        .map(([file, line]) => `${graph.display(file)}:${line}`)));
  }

  private tests(graph: Graph, path: string) {
    const stem = fileStem(path);
    return [...graph.importers.get(path) ?? []].filter((file) => isTestPath(file) && file !== path)
      .sort((a, b) => Number(fileStem(b) === stem) - Number(fileStem(a) === stem) || compare(a, b));
  }

  private subjects(graph: Graph, path: string, entry: Entry) {
    const stem = fileStem(path);
    const directory = posix.dirname(path);
    const near = (file: string) => posix.dirname(file) === directory ||
      (posix.basename(directory) === "__tests__" && posix.dirname(file) === posix.dirname(directory));
    const resolved = graph.resolved(path);
    const targets = new Set(entry.imports.map((record) => resolved.get(record.spec))
      .filter((file): file is string => Boolean(file && file !== path && !isTestPath(file) &&
        (fileStem(file) === stem || near(file)))));
    return [...targets].sort((a, b) =>
      Number(fileStem(b) === stem) - Number(fileStem(a) === stem) || compare(a, b));
  }
}

// Resolution and reverse edges over the parsed entries. Rebuilt (without
// reparsing) when files appear or disappear or a config changes; updated in
// place when one file's content changes.
class Graph {
  readonly importers = new Map<string, Set<string>>();
  readonly reexporters = new Map<string, Set<string>>();
  private readonly resolutions = new Map<string, Map<string, string | undefined>>();
  private readonly traces = new Map<string, Step[]>();
  private readonly resolver: Resolver;
  private readonly byBasename = new Map<string, string[]>();
  private readonly entries: ReadonlyMap<string, Entry>;

  constructor(entries: ReadonlyMap<string, Entry>,
    present: ReadonlySet<string>, configs: ReadonlyMap<string, Json>) {
    this.entries = entries;
    this.resolver = new Resolver(present, configs);
    for (const file of present) {
      const list = this.byBasename.get(posix.basename(file)) ?? [];
      list.push(file);
      this.byBasename.set(posix.basename(file), list);
    }
    for (const [file, entry] of entries) this.link(file, entry);
  }

  link(file: string, entry: Entry) {
    this.traces.clear();
    const resolved = new Map<string, string | undefined>();
    for (const spec of new Set([...entry.imports, ...entry.reexports].map((item) => item.spec)))
      resolved.set(spec, this.resolver.resolve(file, spec));
    this.resolutions.set(file, resolved);
    for (const record of entry.imports) addEdge(this.importers, resolved.get(record.spec), file);
    for (const record of entry.reexports) addEdge(this.reexporters, resolved.get(record.spec), file);
  }

  unlink(file: string, entry: Entry) {
    this.traces.clear();
    const resolved = this.resolutions.get(file);
    for (const record of entry.imports) this.importers.get(resolved?.get(record.spec) ?? "")?.delete(file);
    for (const record of entry.reexports) this.reexporters.get(resolved?.get(record.spec) ?? "")?.delete(file);
    this.resolutions.delete(file);
  }

  resolved(file: string) {
    return this.resolutions.get(file) ?? new Map<string, string | undefined>();
  }

  // The chain of (file, name) an imported name passes through, from the
  // module it is imported from to the file that declares it.
  trace(file: string, name: string, seen = new Set<string>()): Step[] {
    const key = `${file}\0${name}`;
    const cached = this.traces.get(key);
    if (cached) return cached;
    const step = { file, name };
    const entry = this.entries.get(file);
    if (!entry || entry.exports.has(name) || seen.has(key)) return [step];
    seen.add(key);
    const resolved = this.resolved(file);
    let rest: Step[] = [];
    const named = entry.reexports.find((item) => item.as === name && item.from !== "*");
    if (named) {
      const target = resolved.get(named.spec);
      if (target) rest = this.trace(target, named.from, seen);
    } else if (name !== "default") {
      for (const star of entry.reexports.filter((item) => item.as === "*")) {
        const target = resolved.get(star.spec);
        const chain = target ? this.trace(target, name, seen) : [];
        if (chain.length && this.declares(chain.at(-1)!)) { rest = chain; break; }
      }
    }
    const chain = [step, ...rest];
    this.traces.set(key, chain);
    return chain;
  }

  kind(file: string, name: string) {
    const last = this.trace(file, name).at(-1)!;
    return this.entries.get(last.file)?.exports.get(last.name);
  }

  // The shortest path suffix that names the file unambiguously in the workspace.
  display(file: string) {
    const segments = file.split("/");
    const same = this.byBasename.get(segments.at(-1)!) ?? [];
    for (let count = 1; count < segments.length; count++) {
      const suffix = segments.slice(-count).join("/");
      if (same.filter((other) => other === suffix || other.endsWith(`/${suffix}`)).length <= 1) return suffix;
    }
    return file;
  }

  private declares(step: Step) {
    const entry = this.entries.get(step.file);
    return Boolean(entry?.exports.has(step.name) ||
      entry?.reexports.some((item) => item.as === step.name));
  }
}

class Resolver {
  private readonly cache = new Map<string, string | undefined>();
  private readonly packages = new Map<string, string>();
  private readonly pathConfigs = new Map<string, PathConfig | undefined>();
  private readonly present: ReadonlySet<string>;
  private readonly configs: ReadonlyMap<string, Json>;

  constructor(present: ReadonlySet<string>, configs: ReadonlyMap<string, Json>) {
    this.present = present;
    this.configs = configs;
    for (const path of [...configs.keys()].sort()) {
      const name = configs.get(path)?.name;
      if (posix.basename(path) === "package.json" && typeof name === "string" && !this.packages.has(name))
        this.packages.set(name, directoryOf(path));
    }
  }

  resolve(from: string, rawSpec: string) {
    const spec = rawSpec.replace(/\?.*$/u, "");
    const directory = directoryOf(from);
    const key = `${directory}\0${spec}`;
    if (!this.cache.has(key)) this.cache.set(key, this.resolveUncached(directory, spec));
    return this.cache.get(key);
  }

  private resolveUncached(directory: string, spec: string) {
    if (!spec || spec.startsWith("/")) return undefined;
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))
      return this.file(joinPath(directory, spec));
    if (spec.startsWith("#")) return this.packageImport(directory, spec);
    const config = this.pathConfig(directory);
    const mapped = config?.paths && matchPattern(config.paths, spec);
    if (mapped) for (const target of conditionTargets(mapped.value)) {
      const found = this.file(joinPath(config.pathsBase ?? "", target.replaceAll("*", mapped.star)));
      if (found) return found;
    }
    if (config?.baseUrl !== undefined) {
      const found = this.file(joinPath(config.baseUrl, spec));
      if (found) return found;
    }
    return this.workspacePackage(spec);
  }

  private packageImport(directory: string, spec: string) {
    for (let current: string | undefined = directory; current !== undefined; current = parentOf(current)) {
      const imports = record(this.configs.get(childPath(current, "package.json"))?.imports);
      if (!imports) continue;
      const mapped = matchPattern(imports, spec);
      return mapped ? this.packageTarget(current, mapped.value, mapped.star) : undefined;
    }
    return undefined;
  }

  private workspacePackage(spec: string) {
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const directory = this.packages.get(name);
    if (directory === undefined) return undefined;
    const subpath = spec === name ? "." : `.${spec.slice(name.length)}`;
    const json = this.configs.get(childPath(directory, "package.json"))!;
    if (json.exports !== undefined) {
      const exportsField = record(json.exports);
      if (!exportsField || !Object.keys(exportsField).some((key) => key.startsWith(".")))
        return subpath === "." ? this.packageTarget(directory, json.exports, "") : undefined;
      const mapped = matchPattern(exportsField, subpath);
      return mapped ? this.packageTarget(directory, mapped.value, mapped.star) : undefined;
    }
    const fields = subpath === "."
      ? [json.source, json.types, json.typings, json.module, json.main, "./index"] : [subpath];
    return this.packageTarget(directory, fields.filter((field) => typeof field === "string"), "");
  }

  // Package entries usually name build output; map dist/*.js back to src/*.ts.
  private packageTarget(directory: string, value: unknown, star: string) {
    for (const target of conditionTargets(value)) {
      const path = joinPath(directory, target.replaceAll("*", star));
      const found = this.file(path) ??
        this.file(path?.replace(new RegExp(`^(${escapeRegExp(directory ? `${directory}/` : "")})(?:dist|build|lib|out)/`, "u"), "$1src/"));
      if (found) return found;
    }
    return undefined;
  }

  private file(path: string | undefined) {
    if (path === undefined) return undefined;
    const declaration = /\.d\.([cm]?)ts$/u.exec(path);
    const stem = path.replace(/\.[^./]+$/u, "");
    const extension = path.slice(stem.length);
    const candidates = declaration
      ? [`${path.slice(0, -declaration[0].length)}.${declaration[1]}ts`, `${path.slice(0, -declaration[0].length)}.tsx`]
      : jsToTs[extension] ? [...jsToTs[extension]!.map((suffix) => stem + suffix), path]
      : sourceExtensions.includes(extension) ? [path]
      : [...sourceExtensions.map((suffix) => path + suffix), ...indexNames.map((name) => joinPath(path, name))];
    return candidates.find((candidate) => candidate !== undefined && this.present.has(candidate));
  }

  private pathConfig(directory: string): PathConfig | undefined {
    if (this.pathConfigs.has(directory)) return this.pathConfigs.get(directory);
    let config: PathConfig | undefined;
    const file = ["tsconfig.json", "jsconfig.json"].map((name) => childPath(directory, name))
      .find((path) => this.configs.has(path));
    if (file) config = this.loadConfig(file, new Set());
    else if (directory) config = this.pathConfig(parentOf(directory) ?? "");
    this.pathConfigs.set(directory, config);
    return config;
  }

  private loadConfig(file: string, seen: Set<string>): PathConfig | undefined {
    const json = this.configs.get(file);
    if (!json || seen.has(file)) return undefined;
    seen.add(file);
    const directory = directoryOf(file);
    let config: PathConfig = {};
    for (const parent of [json.extends].flat()) {
      if (typeof parent !== "string") continue;
      const inherited = this.loadConfig(this.configPath(directory, parent) ?? "", seen);
      if (inherited) config = { ...config, ...inherited };
    }
    const options = record(json.compilerOptions) ?? {};
    if (typeof options.baseUrl === "string") config.baseUrl = joinPath(directory, options.baseUrl);
    const paths = record(options.paths);
    if (paths) config = { ...config, paths, pathsBase: directory };
    if (config.baseUrl !== undefined && config.paths) config.pathsBase = config.baseUrl;
    if (config.paths || config.baseUrl !== undefined) return config;
    for (const reference of Array.isArray(json.references) ? json.references : []) {
      const target = joinPath(directory, String(record(reference)?.path ?? ""));
      const referenced = target === undefined ? undefined : this.configs.has(target)
        ? this.loadConfig(target, seen) : this.loadConfig(joinPath(target, "tsconfig.json") ?? "", seen);
      if (referenced?.paths || referenced?.baseUrl !== undefined) return referenced;
    }
    return config;
  }

  private configPath(directory: string, parent: string) {
    if (parent.startsWith(".")) {
      const path = joinPath(directory, parent);
      return path && !this.configs.has(path) && this.configs.has(`${path}.json`) ? `${path}.json` : path;
    }
    const parts = parent.split("/");
    const name = parent.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const packageDirectory = this.packages.get(name);
    if (packageDirectory === undefined) return undefined;
    const rest = parent.slice(name.length + 1) || "tsconfig.json";
    return joinPath(packageDirectory, rest.endsWith(".json") ? rest : `${rest}.json`);
  }
}


function siteVariants(name: string, sites: string[]) {
  const total = sites.length;
  const many = `${name} ← ${total} file${total === 1 ? "" : "s"}`;
  if (total > manyUsers) return [many];
  const variants: string[] = [];
  for (let count = Math.min(sitesPerExport, total); count > 0; count--)
    variants.push(`${name} ← ${sites.slice(0, count).join(", ")}${total > count ? ` +${total - count}` : ""}`);
  return [...variants, many];
}

function listVariants(label: string, names: string[], shown: number) {
  const variants: string[] = [];
  for (let count = Math.min(shown, names.length); count > 0; count--)
    variants.push(`${label}: ${names.slice(0, count).join(", ")}${names.length > count ? ` +${names.length - count}` : ""}`);
  return variants;
}

function matchPattern(map: Record<string, unknown>, spec: string) {
  if (Object.hasOwn(map, spec)) return { value: map[spec], star: "" };
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (!best || prefix.length > best.key.indexOf("*"))
      best = { key, star: spec.slice(prefix.length, spec.length - suffix.length) };
  }
  return best && { value: map[best.key], star: best.star };
}

function conditionTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(conditionTargets);
  const conditions = record(value);
  if (!conditions) return [];
  const rank = (condition: string) => (conditionOrder.indexOf(condition) + 1 || conditionOrder.length + 1);
  return Object.keys(conditions).sort((a, b) => rank(a) - rank(b)).flatMap((key) => conditionTargets(conditions[key]));
}

function parseJson(path: string, text: string) {
  if (posix.basename(path) === "package.json") {
    try { return record(JSON.parse(text)); } catch { return undefined; }
  }
  return record(ts.parseConfigFileTextToJson(path, text).config);
}

function indexable(path: string, content: Buffer) {
  if (content.byteLength > maxIndexedBytes || /\.min\.[cm]?js$/u.test(path)) return false;
  if (path.split("/").some((segment) => generatedDirectories.has(segment))) return false;
  const head = content.subarray(0, 600).toString("utf8");
  return !/@generated\b|auto-?generated|do not edit/iu.test(head);
}

export function isSourcePath(path: string) {
  return sourceExtensions.some((extension) => path.endsWith(extension)) && !/\.d\.[cm]?ts$/u.test(path);
}

function isConfigPath(path: string) {
  const name = posix.basename(path);
  return name === "package.json" || (/^(?:ts|js)config.*\.json$/u.test(name));
}

function isTestPath(path: string) {
  return /(?:^|\/)__tests__\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

function fileStem(path: string) {
  return posix.basename(path).replace(/\.[cm]?[jt]sx?$/u, "").replace(/\.(?:test|spec)$/u, "");
}

function directoryOf(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function parentOf(directory: string) {
  return directory ? directoryOf(directory) : undefined;
}

function joinPath(directory: string, relative: string) {
  const joined = posix.normalize(posix.join(directory || ".", relative));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return undefined;
  return joined === "." ? "" : joined.replace(/\/$/u, "");
}

const childPath = (directory: string, name: string) => directory ? `${directory}/${name}` : name;

function addEdge(map: Map<string, Set<string>>, target: string | undefined, file: string) {
  if (!target || target === file) return;
  const set = map.get(target) ?? new Set<string>();
  set.add(file);
  map.set(target, set);
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

async function settlesWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal) {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      new Promise<boolean>((_, reject) => {
        onAbort = () => reject(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
