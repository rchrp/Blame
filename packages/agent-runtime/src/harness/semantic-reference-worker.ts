// Read-only compiler service for one workspace root, in a bounded worker that
// answers one request at a time. No plugins, emit or processes.
//
// A project (its configuration, language service and every input it
// observed) stays between requests. Each request first checks all those
// inputs again: when only source files changed, the service reparses them and
// keeps the rest; any other change (configuration, package metadata, a file
// or directory appearing or disappearing, a symlink retargeted) rebuilds the
// project. Either way the answer is the one a new service would give.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import ts from "typescript";
import { compilerRenamePlan } from "./semantic-rename-plan.js";
import { dependencyDeclaration } from "./dependency-declaration.js";
import {
  semanticReferenceLimits as limits,
  type ReferenceFootprint,
  type SemanticReferenceReply,
  type SemanticReferenceRequest,
  type DependencyDeclarationRequest,
  type DependencyDeclarationReply,
} from "./semantic-reference-types.js";

type Request = SemanticReferenceRequest | DependencyDeclarationRequest;
type Reply = SemanticReferenceReply | DependencyDeclarationReply;
type Kind = "references" | "declaration";

const root = resolve((workerData as { root: string }).root);
// Both kinds of project share parsed files when their settings match.
const registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root);
const projects = new Map<Kind, Project>();
const local = (path: string) => {
  const value = relative(root, path);
  return (
    value !== ".." &&
    !value.startsWith("../") &&
    !value.startsWith("..\\") &&
    !isAbsolute(value)
  );
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const scriptPath = (path: string) => /\.[cm]?[jt]sx?$/iu.test(path);

// What a project read and looked up, through a host that records it.
class Inputs {
  readonly reads = new Map<string, { text: string; hash: string }>();
  readonly existence = new Map<string, boolean>();
  readonly realpaths = new Map<string, string>();
  // Module resolution also asks these; they decide whether earlier
  // resolutions still hold.
  readonly directories = new Map<string, boolean>();
  readonly listings = new Map<string, string>();
  readonly host: ts.ParseConfigFileHost & ts.ModuleResolutionHost;
  private bytes = 0;

  constructor(readonly kind: Kind) {
    const host: ts.ParseConfigFileHost & ts.ModuleResolutionHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
      readFile: (path) => {
        const key = resolve(path);
        const cached = this.reads.get(key);
        if (cached) return cached.text;
        let text: string | undefined;
        try {
          text = readFileSync(key, "utf8");
        } catch {
          host.fileExists(key);
          return undefined;
        }
        this.bytes += Buffer.byteLength(text);
        if (this.reads.size >= limits.observedFiles || this.bytes > limits.observedBytes)
          throw new Error("project_read_budget_exceeded");
        this.reads.set(key, { text, hash: digest(text) });
        return text;
      },
      fileExists: (path) => {
        const key = resolve(path);
        const cached = this.existence.get(key);
        if (cached !== undefined) return cached;
        if (this.existence.size >= limits.observedExistence)
          throw new Error("project_lookup_budget_exceeded");
        const exists = ts.sys.fileExists(key);
        this.existence.set(key, exists);
        return exists;
      },
      directoryExists: (path) => {
        const key = resolve(path);
        const cached = this.directories.get(key);
        if (cached !== undefined) return cached;
        const exists = ts.sys.directoryExists(key);
        this.directories.set(key, exists);
        return exists;
      },
      getDirectories: (path) => {
        const key = resolve(path);
        const cached = this.listings.get(key);
        if (cached !== undefined) return cached ? cached.split("\0") : [];
        const names = ts.sys.getDirectories(key);
        this.listings.set(key, names.join("\0"));
        return names;
      },
      realpath: (path) => {
        const key = resolve(path);
        const cached = this.realpaths.get(key);
        if (cached) return cached;
        if (kind === "declaration" && this.realpaths.size >= limits.observedExistence)
          throw new Error("project_realpath_budget_exceeded");
        const resolved = this.realpath(key);
        this.realpaths.set(key, resolved);
        return resolved;
      },
    };
    this.host = host;
  }

  // Declaration queries bind resolution through symlinks and report it: a
  // retargeted installation must not validate merely because the previous
  // canonical file exists. References resolve as the compiler does.
  realpath(path: string) {
    return this.kind === "declaration" ? realpathSync(path) : ts.sys.realpath!(path);
  }

  // The source files whose content changed since the project read them, or
  // undefined when anything else changed: a lookup that answers differently,
  // a read file gone, another kind of file changed.
  changedSources(isSource: (path: string) => boolean): Map<string, string> | undefined {
    const same = <T>(entries: Map<string, T>, now: (path: string) => T) => {
      for (const [path, value] of entries) {
        try {
          if (now(path) !== value) return false;
        } catch {
          return false;
        }
      }
      return true;
    };
    if (
      !same(this.existence, (path) => ts.sys.fileExists(path)) ||
      !same(this.directories, (path) => ts.sys.directoryExists(path)) ||
      !same(this.listings, (path) => ts.sys.getDirectories(path).join("\0")) ||
      !same(this.realpaths, (path) => this.realpath(path))
    )
      return undefined;
    const changed = new Map<string, string>();
    for (const [path, entry] of this.reads) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      if (text === entry.text) continue;
      if (!scriptPath(path) || !isSource(path)) return undefined;
      changed.set(path, text);
    }
    for (const [path, text] of changed) {
      this.bytes += Buffer.byteLength(text) - Buffer.byteLength(this.reads.get(path)!.text);
      this.reads.set(path, { text, hash: digest(text) });
    }
    // A new service reading this much would stop at the budget too.
    return this.bytes > limits.observedBytes ? undefined : changed;
  }

  footprint(): ReferenceFootprint {
    return {
      reads: [...this.reads].map(([path, value]) => ({ path, hash: value.hash })),
      existence: [...this.existence].map(([path, exists]) => ({ path, exists })),
      ...(this.kind === "declaration"
        ? { realpaths: [...this.realpaths].map(([path, resolved]) => ({ path, resolved })) }
        : {}),
    };
  }
}

class Project {
  readonly service: ts.LanguageService;
  // Rename planning checks its edits in memory, then drops them.
  readonly overlay = new Map<string, string>();
  program?: ts.Program;
  unresolved?: { program: ts.Program; value: boolean };
  private version = 0;

  constructor(
    readonly inputs: Inputs,
    readonly config: string,
    public parsed: ts.ParsedCommandLine,
  ) {
    const { host } = inputs;
    const scriptVersion = (path: string) => {
      const key = resolve(path);
      if (this.overlay.has(key)) return `overlay-${this.version}`;
      host.readFile(key);
      return inputs.reads.get(key)?.hash ?? "";
    };
    this.service = ts.createLanguageService(
      {
        ...host,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        readDirectory: (...args) => [...ts.sys.readDirectory(...args)],
        getCompilationSettings: () => this.parsed.options,
        getScriptFileNames: () => this.parsed.fileNames,
        getScriptVersion: scriptVersion,
        getProjectVersion: () => String(this.version),
        getScriptSnapshot: (path) => {
          const source = this.overlay.get(resolve(path)) ?? host.readFile(path);
          return source === undefined
            ? undefined
            : ts.ScriptSnapshot.fromString(source);
        },
        getCurrentDirectory: () => dirname(config),
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        getProjectReferences: () => this.parsed.projectReferences,
      },
      registry,
    );
  }

  // False when the project must be rebuilt for this request.
  refresh() {
    const changed = this.inputs.changedSources(
      (path) => Boolean(this.program?.getSourceFile(path)),
    );
    if (changed?.size) this.version++;
    return changed !== undefined;
  }

  configure(parsed: ts.ParsedCommandLine) {
    const names = this.parsed.fileNames;
    if (
      names.length !== parsed.fileNames.length ||
      names.some((name, index) => name !== parsed.fileNames[index])
    )
      this.version++;
    this.parsed = parsed;
  }

  overlayFiles(changed: Map<string, string>) {
    for (const [path, text] of changed) this.overlay.set(resolve(path), text);
    this.version++;
  }

  clearOverlay() {
    if (!this.overlay.size) return;
    this.overlay.clear();
    this.version++;
  }
}

function drop(kind: Kind) {
  projects.get(kind)?.service.dispose();
  projects.delete(kind);
}

function configPath(target: string, host: ts.ParseConfigFileHost) {
  let directory = dirname(target);
  while (local(directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const path = resolve(directory, name);
      if (host.fileExists(path)) return path;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function serve(request: Request): Reply {
  const kind: Kind = "declaration" in request ? "declaration" : "references";
  const kept = projects.get(kind);
  if (kept && !kept.refresh()) drop(kind);
  const reused = projects.has(kind);
  try {
    return query(request, kind);
  } catch (error) {
    // A failed request leaves no project behind. One that a kept project's
    // earlier reads pushed over a budget is answered by a new project.
    drop(kind);
    if (!reused || !(error instanceof Error) || !error.message.endsWith("_budget_exceeded"))
      throw error;
  }
  try {
    return query(request, kind);
  } catch (error) {
    drop(kind);
    throw error;
  }
}

function query(request: Request, kind: Kind): Reply {
  const kept = projects.get(kind);
  const inputs = kept?.inputs ?? new Inputs(kind);
  const { host } = inputs;
  const targetPath = resolve(root, request.target.path);
  if (!local(targetPath))
    return { status: "unavailable", reason: "target_outside_workspace" };
  const config = configPath(targetPath, host);
  if (!config) return { status: "unavailable", reason: "no_project_config" };
  if (kept && kept.config !== config) {
    drop(kind);
    return query(request, kind);
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
  if (!parsed || parsed.errors.length) {
    drop(kind);
    return { status: "unavailable", reason: "invalid_project_config" };
  }
  if (parsed.fileNames.length > limits.rootFiles)
    return { status: "unavailable", reason: "project_file_budget_exceeded" };
  if (parsed.fileNames.some((path) => !local(path)))
    return { status: "unavailable", reason: "project_roots_outside_workspace" };
  const text = host.readFile(targetPath);
  if (text === undefined || digest(text) !== request.target.hash)
    return { status: "unavailable", reason: "source_changed" };
  if (!kept) {
    // The two kinds share parsed files only within one configuration; the
    // heap holds one configuration's files at a time, as a new worker would.
    const other: Kind = kind === "declaration" ? "references" : "declaration";
    if (projects.get(other)?.config !== config) drop(other);
  }
  const project = kept ?? new Project(inputs, config, parsed);
  projects.set(kind, project);
  project.configure(parsed);
  const { service } = project;
  try {
    const program = service.getProgram();
    project.program = program;
    const source = program?.getSourceFile(targetPath);
    if (!source)
      return { status: "unavailable", reason: "target_not_in_project" };
    const projectSummary = (warnings: string[]) => ({
      config: relative(root, config).split("\\").join("/"),
      rootFiles: parsed.fileNames.length,
      loadedFiles: program!.getSourceFiles().length,
      compilerVersion: ts.version,
      scope: "configured_project" as const,
      warnings,
    });
    if ("declaration" in request) {
      const declaration = dependencyDeclaration(program!, source, request, host);
      return {
        status: "ok", declaration,
        footprint: inputs.footprint(),
        project: projectSummary([
          ...(parsed.projectReferences?.length ? ["project_references_not_fully_expanded"] : []),
          ...(program!.getOptionsDiagnostics().length || program!.getGlobalDiagnostics().length
            ? ["compiler_project_diagnostics"] : []),
          "declarations_describe_types_not_runtime_behavior",
        ]),
      };
    }
    const start = Buffer.from(text)
      .subarray(0, request.target.start)
      .toString("utf8").length;
    const end = Buffer.from(text)
      .subarray(0, request.target.end)
      .toString("utf8").length;
    const names: ts.Identifier[] = [];
    const leaf = request.target.name.split(/[./]/u).at(-1);
    function visit(node: ts.Node) {
      if (node.getEnd() < start || node.getStart(source) > end) return;
      const named = node as ts.NamedDeclaration;
      if (
        named.name &&
        ts.isIdentifier(named.name) &&
        named.name.text === leaf &&
        named.name.getStart(source) >= start &&
        named.name.getEnd() <= end
      )
        names.push(named.name);
      ts.forEachChild(node, visit);
    }
    visit(source);
    names.sort((a, b) => a.getStart(source) - b.getStart(source));
    const name = names[0];
    if (!name)
      return {
        status: "unavailable",
        reason: "unsupported_target_declaration",
      };
    const position = name.getStart(source);
    const references = service.getReferencesAtPosition(targetPath, position);
    if (!references)
      return { status: "unavailable", reason: "unresolved_target" };
    if (references.length > limits.locations)
      return { status: "unavailable", reason: "reference_budget_exceeded" };
    let locations = references.flatMap((entry) => {
      if (
        !local(entry.fileName) ||
        entry.fileName.split(/[\\/]/u).includes("node_modules")
      )
        return [];
      if (
        resolve(entry.fileName) === targetPath &&
        entry.textSpan.start === position
      )
        return [];
      const content = host.readFile(entry.fileName);
      if (content === undefined)
        throw new Error("reference_source_unavailable");
      const from = entry.textSpan.start,
        to = from + entry.textSpan.length;
      const first = content.lastIndexOf("\n", from - 1) + 1;
      const next = content.indexOf("\n", to);
      const line = content.slice(0, from).split("\n").length;
      return [
        {
          path: relative(root, entry.fileName).split("\\").join("/"),
          range: [
            Buffer.byteLength(content.slice(0, from)),
            Buffer.byteLength(content.slice(0, to)),
          ] as [number, number],
          lines: [
            line,
            line + content.slice(from, to).split("\n").length - 1,
          ] as [number, number],
          snippet: content
            .slice(first, next < 0 ? content.length : next)
            .trim()
            .slice(0, 400),
          isWrite: entry.isWriteAccess,
        },
      ];
    });
    const warnings: string[] = [];
    if (parsed.projectReferences?.length)
      warnings.push("project_references_not_fully_expanded");
    if (
      program?.getOptionsDiagnostics().length ||
      program?.getGlobalDiagnostics().length
    )
      warnings.push("compiler_project_diagnostics");
    // The same program, on the same checked inputs, resolves the same way.
    let unresolved = project.unresolved && project.unresolved.program === program
      ? project.unresolved.value : undefined;
    if (unresolved === undefined) {
      unresolved = false;
      const ambientModules = new Set(
        program
          ?.getTypeChecker()
          .getAmbientModules()
          .map((symbol) => symbol.name.replace(/^"|"$/gu, "")),
      );
      for (const file of program?.getSourceFiles() ?? []) {
        if (!local(file.fileName) || file.isDeclarationFile) continue;
        for (const imported of ts.preProcessFile(file.text).importedFiles)
          if (
            !ambientModules.has(imported.fileName) &&
            !ts.resolveModuleName(
              imported.fileName,
              file.fileName,
              parsed.options,
              host,
            ).resolvedModule
          )
            unresolved = true;
      }
      project.unresolved = { program: program!, value: unresolved };
    }
    if (unresolved) warnings.push("unresolved_imports");
    if (request.renameTo !== undefined) {
      const shadowExtensions = targetPath.endsWith(".cjs")
        ? [".cts"]
        : targetPath.endsWith(".mjs")
          ? [".mts"]
          : targetPath.endsWith(".jsx")
            ? [".tsx"]
            : targetPath.endsWith(".js")
              ? [".ts", ".tsx"]
              : [];
      if (
        shadowExtensions.some((extension) =>
          host.fileExists(targetPath.replace(/\.[^.]+$/u, extension)),
        )
      )
        throw new Error("ambiguous_js_ts_source_shadow");
      if (warnings.length)
        throw new Error(`incomplete_rename_project: ${warnings.join(",")}`);
      const renamed = compilerRenamePlan(
        service,
        program!,
        targetPath,
        position,
        name.text,
        request.renameTo,
        host.readFile,
        (path) => local(path) && !path.split(/[\\/]/u).includes("node_modules"),
        (changed) => project.overlayFiles(changed),
      );
      locations = renamed.map((entry) => {
        const content = host.readFile(entry.fileName)!;
        const from = entry.textSpan.start,
          to = from + entry.textSpan.length;
        const line = content.slice(0, from).split("\n").length;
        return {
          path: relative(root, entry.fileName).split("\\").join("/"),
          range: [
            Buffer.byteLength(content.slice(0, from)),
            Buffer.byteLength(content.slice(0, to)),
          ],
          lines: [line, line],
          snippet: content.slice(from, to),
          isWrite: true,
          replacement:
            (entry.prefixText ?? "") +
            request.renameTo! +
            (entry.suffixText ?? ""),
        };
      });
    }
    return {
      status: "ok",
      locations,
      footprint: inputs.footprint(),
      project: projectSummary(warnings),
    };
  } finally {
    project.clearOverlay();
  }
}

parentPort?.on("message", (request: Request) => {
  let reply: Reply;
  try {
    reply = serve(request);
  } catch (error) {
    reply = {
      status: "unavailable",
      reason:
        error instanceof Error ? error.message.slice(0, 240) : "compiler_error",
    };
  }
  parentPort?.postMessage(reply);
});
