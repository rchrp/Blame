// The temporary Vite server behind open_component_preview. Blame passes
// this module to `node -e`, so nothing is written to the project. It loads
// the project's own Vite with the config of the package that holds the
// preview file (aliases, plugins, CSS), serves a generated page and entry,
// pre-bundles only what the preview files import, and stops by itself when
// nobody has asked it anything for a while.
//
// A React or Vue 3 package without Vite, such as a Next.js, Vue CLI or Nuxt
// app, gets Blame's own Vite instead, with @vitejs/plugin-react or
// @vitejs/plugin-vue, installed once per environment in the host's toolkit
// folder, outside the worktree. The framework and every other import still
// resolve from the project's node_modules; its PostCSS config and tsconfig
// or jsconfig paths apply. Next.js imports that only work inside Next are
// replaced by small shims, and a Vue CLI package keeps its @ alias for
// src, in this server only. A Nuxt package also gets what Nuxt generates at
// build time: auto-imports with unimport, its components by their Nuxt
// names, its aliases, and shims for the composables and components Nuxt
// provides.

export const componentPreviewPagePath = "/__blame_component_preview__";
export const componentPreviewReportPrefix = "BLAME_COMPONENT_PREVIEW ";

// The versions of Blame's own Vite, the same as Blame's packages use.
export const componentPreviewToolkitVersions = {
  pluginReact: "6.1.2",
  pluginVue: "6.0.10",
  unimport: "7.0.2",
  vite: "8.3.5",
} as const;

export type ComponentPreviewToolkit = {
  // "next" adds the Next.js shims to React; "vue" uses @vitejs/plugin-vue;
  // "nuxt" adds Nuxt's auto-imports and shims to it.
  framework: "next" | "nuxt" | "react" | "vue";
  // Folder of Blame's own Vite installs, as the server process sees it.
  root: string;
};

type ComponentPreviewToolkitPackage = { name: string; version: string };

// What a framework needs beside Vite, its Vite plugin first. Each set gets
// its own toolkit folder, so a package is only installed for a project
// that needs it.
export function componentPreviewToolkitPackages(
  framework: ComponentPreviewToolkit["framework"],
): ComponentPreviewToolkitPackage[] {
  const { pluginReact, pluginVue, unimport } = componentPreviewToolkitVersions;
  if (framework === "next" || framework === "react")
    return [{ name: "@vitejs/plugin-react", version: pluginReact }];
  const vue = { name: "@vitejs/plugin-vue", version: pluginVue };
  return framework === "nuxt"
    ? [vue, { name: "unimport", version: unimport }]
    : [vue];
}

// A framework's toolkit folder, before the platform suffix the server adds,
// such as "vite-8.3.5-plugin-vue-6.0.10".
export function componentPreviewToolkitFolder(
  framework: ComponentPreviewToolkit["framework"],
) {
  return [
    `vite-${componentPreviewToolkitVersions.vite}`,
    ...componentPreviewToolkitPackages(framework).map(
      ({ name, version }) => `${name.replace(/^@vitejs\//u, "")}-${version}`,
    ),
  ].join("-");
}

export type ComponentPreviewServerOptions = {
  // Suffix of the package's Vite cache directory, so this server never
  // rewrites the cache of the app's own dev server.
  cacheName: string;
  // Address the server binds to where it runs.
  host: string;
  idleMs: number;
  // Package directory as the server process sees it.
  packageDir: string;
  port: number;
  // Secret path segment: the desktop only trusts a server that knows it.
  token: string;
  // Blame's own Vite, for a package without one. Absent: the package's
  // own Vite and config.
  toolkit?: ComponentPreviewToolkit;
};

export type ComponentPreviewServerReport =
  // Blame's own Vite is not installed yet in this environment.
  | { event: "installing"; directory: string }
  | {
      event: "listening";
      // What the agent should know about this server, such as the
      // stylesheets a Nuxt app's nuxt.config lists.
      notes?: string[];
      port: number;
      react: boolean;
      // Set when the server runs Blame's own Vite.
      toolkit?: { directory: string; installed: boolean };
      vite: string;
    }
  | { event: "error"; message: string };

export function componentPreviewServerArguments(
  options: ComponentPreviewServerOptions,
) {
  const { toolkit } = options;
  return [
    "--input-type=module",
    "-e",
    componentPreviewServerScript,
    "--",
    options.packageDir,
    options.host,
    String(options.port),
    options.token,
    String(options.idleMs),
    options.cacheName,
    toolkit?.root ?? "",
    toolkit ? componentPreviewToolkitVersions.vite : "",
    toolkit ? componentPreviewToolkitFolder(toolkit.framework) : "",
    toolkit
      ? JSON.stringify(componentPreviewToolkitPackages(toolkit.framework))
      : "",
    toolkit?.framework ?? "",
  ];
}

// One line of the server's stdout, or undefined for Vite's own output.
export function componentPreviewServerReport(
  line: string,
): ComponentPreviewServerReport | undefined {
  if (!line.startsWith(componentPreviewReportPrefix)) return undefined;
  try {
    const value = JSON.parse(
      line.slice(componentPreviewReportPrefix.length),
    ) as Record<string, unknown>;
    if (value.event === "installing")
      return { event: "installing", directory: String(value.directory ?? "") };
    if (value.event === "listening" && typeof value.port === "number") {
      const toolkit = value.toolkit as Record<string, unknown> | undefined;
      const notes = Array.isArray(value.notes)
        ? value.notes.filter((note): note is string => typeof note === "string")
        : [];
      return {
        event: "listening",
        ...(notes.length ? { notes } : {}),
        port: value.port,
        react: value.react === true,
        ...(toolkit && typeof toolkit.directory === "string"
          ? {
              toolkit: {
                directory: toolkit.directory,
                installed: toolkit.installed === true,
              },
            }
          : {}),
        vite: typeof value.vite === "string" ? value.vite : "",
      };
    }
    if (value.event === "error")
      return { event: "error", message: String(value.message ?? "") };
  } catch {
    return undefined;
  }
  return undefined;
}

// Plain JavaScript run by the project's Node. No template expressions and
// no backticks inside: the whole script is one String.raw literal.
export const componentPreviewServerScript = String.raw`
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, host, portText, token, idleText, cacheName, toolkitRoot, toolkitVite, toolkitFolder, toolkitPackagesText, framework] = process.argv.slice(1);
const pagePath = "/__blame_component_preview__/" + token;
const entryId = "virtual:blame-component-preview";
const resolvedEntryId = "\0" + entryId;
const idleMs = Number(idleText) || 660000;
const usesToolkit = Boolean(toolkitVite);
// The packages beside Vite in Blame's own Vite: [{ name, version }].
const toolkitPackages = toolkitPackagesText ? JSON.parse(toolkitPackagesText) : [];
// A Vue or Nuxt package renders through @vitejs/plugin-vue and mount.
const vueFramework = framework === "vue" || framework === "nuxt";
const serverComponentHint = "open_component_preview renders client components in the browser: preview one of its client sub-components with made-up props, or check this screen in the full app.";
const vueMountHint = "A preview file of a Vue package exports mount(element, state), which renders the named state into element, such as createApp(Component, props).mount(element).";
let lastRequest = Date.now();
let server;
let closing = false;
// Scans the project's folders again before a fresh render, such as Nuxt's
// components and composables.
let refreshProjectScan;

// A problem of the package the agent can act on: reported without a stack.
class SetupError extends Error {}

function report(value) {
  process.stdout.write("BLAME_COMPONENT_PREVIEW " + JSON.stringify(value) + "\n");
}

function close() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 3000).unref();
  Promise.resolve(server && server.close()).catch(() => undefined).finally(() => process.exit(0));
}

// The ESM entry of an installed package, read from its package.json.
function packageModule(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let entry = typeof manifest.exports === "string" ? manifest.exports : manifest.exports && manifest.exports["."];
  if (entry && typeof entry === "object") entry = entry.import || entry.default || entry.node;
  if (entry && typeof entry === "object") entry = entry.default || entry.import;
  if (typeof entry !== "string") entry = manifest.module || manifest.main || "index.js";
  return { url: pathToFileURL(join(dirname(manifestPath), entry)).href, version: String(manifest.version || "") };
}

function resolvable(require, id) {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// The package's own package.json, or {} when it is not valid JSON.
function packageManifest() {
  try {
    return plainObject(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")));
  } catch {
    return {};
  }
}

// The packages the package's own package.json declares, with their ranges.
function dependencyRanges() {
  const manifest = packageManifest();
  return new Map(["dependencies", "devDependencies"].flatMap((field) => Object.entries(plainObject(manifest[field]))));
}

// @vitejs/plugin-vue compiles .vue files with the project's own Vue, 3.2.25
// or later.
function checkVue(require) {
  let version;
  try {
    version = String(JSON.parse(readFileSync(require.resolve("vue/package.json"), "utf8")).version || "");
  } catch {
    throw new SetupError("Vue is not installed for " + packageDir + ". open_component_preview never installs the project's dependencies: install them first.");
  }
  const [major, minor, patch] = version.split(".").map((part) => parseInt(part, 10) || 0);
  if (major < 3) throw new SetupError("Vue 2 is not supported: " + packageDir + " has vue " + version + " installed, and without a Vite config open_component_preview renders Vue 3.2.25 or later only. Check this component in the app instead.");
  if (major === 3 && (minor < 2 || (minor === 2 && patch < 25))) throw new SetupError("vue " + version + " is installed for " + packageDir + ": without a Vite config, open_component_preview renders Vue 3.2.25 or later only, which @vitejs/plugin-vue requires. Check this component in the app instead.");
}

// Blame's own Vite: one install per version, platform and C library, so a
// container and the runtime can share the folder, with the packages the
// framework needs.
function toolkitDirectory() {
  const header = process.platform === "linux" && process.report ? process.report.getReport().header : undefined;
  const libc = process.platform !== "linux" ? "" : header && header.glibcVersionRuntime ? "-gnu" : "-musl";
  const root = toolkitRoot || join(homedir(), ".cache", "blame", "component-preview");
  return join(root, toolkitFolder + "-" + process.platform + "-" + process.arch + libc);
}

function installedVersion(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function toolkitReady(directory) {
  return installedVersion(directory, "vite") === toolkitVite && toolkitPackages.every(({ name, version }) => installedVersion(directory, name) === version);
}

// The npm that comes with this Node, else the one on PATH.
function npmCommand() {
  const bin = dirname(process.execPath);
  const cli = [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((path) => existsSync(path));
  if (cli) return { command: process.execPath, args: [cli], shell: false };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [], shell: process.platform === "win32" };
}

function runNpm(args, cwd) {
  const npm = npmCommand();
  return new Promise((resolveRun, reject) => {
    let output = "";
    const keep = (chunk) => {
      output = (output + chunk).slice(-3000);
    };
    const child = spawn(npm.command, npm.args.concat(args), {
      cwd,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
      shell: npm.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => reject(new Error("npm did not start: " + error.message)));
    child.on("exit", (code) => (code === 0 ? resolveRun() : reject(new Error("npm install exited with code " + code + ": " + output.trim()))));
  });
}

// Installs left by a server that was stopped mid-way.
function removeStaleStaging(parent) {
  const before = Date.now() - 3600000;
  for (const name of readdirSync(parent)) {
    if (!name.includes(".staging-")) continue;
    const path = join(parent, name);
    try {
      if (statSync(path).mtimeMs < before) rmSync(path, { force: true, recursive: true });
    } catch {
      // Another server removed it first.
    }
  }
}

// Installs in a staging folder, then renames it: a server never loads a
// half-installed Vite, and two servers installing at once both succeed.
async function installToolkit(directory) {
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  removeStaleStaging(parent);
  const staging = directory + ".staging-" + process.pid + "-" + Date.now().toString(36);
  try {
    mkdirSync(staging, { recursive: true });
    const dependencies = Object.fromEntries([["vite", toolkitVite]].concat(toolkitPackages.map(({ name, version }) => [name, version])));
    const manifest = { name: "blame-component-preview-vite", private: true, dependencies };
    writeFileSync(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await runNpm(["install", "--no-package-lock", "--ignore-scripts", "--loglevel=error", "--cache", join(parent, ".npm-cache")], staging);
    if (!toolkitReady(staging)) throw new Error("npm finished without installing " + Object.entries(dependencies).map(([name, version]) => name + " " + version).join(", ") + ".");
    if (existsSync(directory) && !toolkitReady(directory)) rmSync(directory, { force: true, recursive: true });
    try {
      renameSync(staging, directory);
    } catch (error) {
      if (!toolkitReady(directory)) throw error;
    }
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function pageHtml() {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Component preview</title></head>',
    '<body><div id="root"></div><script type="module" src="/@id/__x00__' + entryId + '"></script></body>',
    "</html>",
  ].join("\n");
}

function entryCode(react) {
  const lines = [];
  if (react) {
    lines.push('import { createElement, isValidElement, useEffect } from "react";');
    lines.push('import { createRoot } from "react-dom/client";');
  }
  lines.push(
    'const params = new URLSearchParams(location.search);',
    'const file = params.get("file") || "";',
    'const state = params.get("state") || "default";',
    'const theme = params.get("theme") === "dark" ? "dark" : "light";',
    'const html = document.documentElement;',
    'html.classList.toggle("dark", theme === "dark");',
    'html.classList.toggle("light", theme === "light");',
    'html.dataset.theme = theme;',
    'html.style.colorScheme = theme;',
    'const finish = (status, message) => {',
    '  if (html.dataset.blamePreviewStatus === "error") return;',
    '  html.dataset.blamePreviewStatus = status;',
    '  if (message) html.dataset.blamePreviewMessage = String(message).slice(0, 2000);',
    '};',
    'const describe = (error) => (error && (error.message || error.reason)) || String(error);',
  );
  if (react)
    lines.push(
      // React renders async components only on the server: it warns, or
      // throws, with "<Name> is an async Client Component".
      'const serverComponentHint = ' + JSON.stringify(serverComponentHint) + ';',
      'const asyncMessage = (name) => name + " is an async component: React renders async components only as Server Components. " + serverComponentHint;',
      'const asyncMarker = " is an async Client Component";',
      'const reactError = (error) => {',
      '  const text = describe(error);',
      '  return text.includes(asyncMarker) ? asyncMessage(text.split(asyncMarker)[0]) : text;',
      '};',
      'const consoleError = console.error;',
      'console.error = function (...args) {',
      '  if (typeof args[0] === "string" && args[0].includes(asyncMarker)) {',
      '    let index = 1;',
      '    finish("error", asyncMessage(args[0].replace(/%s/g, () => String(args[index++])).split(asyncMarker)[0]));',
      '  }',
      '  return consoleError.apply(this, args);',
      '};',
      'const isAsync = (value) => typeof value === "function" && Object.prototype.toString.call(value) === "[object AsyncFunction]";',
      // Ready once React has committed the tree, not when it was scheduled.
      'function Rendered({ children }) {',
      '  useEffect(() => finish("ready"), []);',
      '  return children;',
      '}',
    );
  lines.push(
    'addEventListener("error", (event) => finish("error", event.message || describe(event.error)));',
    'addEventListener("unhandledrejection", (event) => finish("error", describe(event.reason)));',
    'const element = document.getElementById("root");',
    'try {',
    '  const preview = await import(/* @vite-ignore */ "/" + file.split("/").map(encodeURIComponent).join("/"));',
    '  const names = Object.keys(preview).filter((name) => name !== "mount");',
    '  if (typeof preview.mount === "function") {',
    '    await preview.mount(element, state);',
    '    finish("ready");',
  );
  if (vueFramework)
    // A Vue package renders every state through mount.
    lines.push(
      '  } else {',
      '    finish("error", ' + JSON.stringify(vueMountHint) + ' + " Its exports: " + (names.join(", ") || "none") + ".");',
      '  }',
    );
  else {
    lines.push(
      '  } else if (!(state in preview)) {',
      '    finish("error", "The preview file exports no state named " + JSON.stringify(state) + ". Its exports: " + (names.join(", ") || "none") + ".");',
    );
    if (react)
      lines.push(
        '  } else {',
        '    const value = preview[state];',
        '    const node = typeof value === "function" ? createElement(value) : value;',
        '    if (!isValidElement(node)) {',
        '      finish("error", "The export " + JSON.stringify(state) + " is not a React element: export it as <Component ... />, or export mount(element, state).");',
        '    } else if (isAsync(node.type)) {',
        '      finish("error", asyncMessage("<" + (node.type.displayName || node.type.name || "Anonymous") + ">"));',
        '    } else {',
        '      createRoot(element, { onUncaughtError: (error) => { console.error(error); finish("error", reactError(error)); } }).render(createElement(Rendered, null, node));',
        '    }',
        '  }',
      );
    else
      lines.push(
        '  } else {',
        '    finish("error", "React is not installed for this package: export mount(element, state) to render " + JSON.stringify(state) + ".");',
        '  }',
      );
  }
  lines.push(
    '} catch (error) {',
    '  console.error(error);',
    '  finish("error", describe(error));',
    '}',
  );
  return lines.join("\n");
}

async function invalidateModules() {
  if (refreshProjectScan) await refreshProjectScan();
  const graphs = server.environments
    ? Object.values(server.environments).map((environment) => environment.moduleGraph)
    : [server.moduleGraph];
  for (const graph of graphs) if (graph && typeof graph.invalidateAll === "function") graph.invalidateAll();
}

function previewPlugin(react, nuxt) {
  return {
    name: "blame:component-preview",
    enforce: "pre",
    config: {
      order: "post",
      handler(config) {
        const cacheDir = config.cacheDir ? resolve(packageDir, config.cacheDir) : join(packageDir, "node_modules", ".vite");
        config.cacheDir = cacheDir + "-" + cacheName;
        config.base = "/";
        config.appType = "custom";
        config.server = {
          ...(config.server || {}),
          host,
          port: Number(portText),
          strictPort: true,
          open: false,
          https: undefined,
          proxy: undefined,
          origin: undefined,
          warmup: undefined,
          hmr: { overlay: true },
        };
        const optimizeDeps = config.optimizeDeps || {};
        // The entry imports React itself, and a Vue preview file imports
        // Vue: bundled up front, a first render never waits for a
        // re-optimization and its reload. Nuxt's composables and utils
        // are imported by no file, only auto-imported: scanned too.
        const frameworkDeps = vueFramework ? ["vue"] : react ? ["react", "react-dom/client", "react/jsx-dev-runtime"] : [];
        const include = frameworkDeps.length ? [...new Set([...(optimizeDeps.include || []), ...frameworkDeps])] : optimizeDeps.include;
        const entries = ["**/*.blame-preview.*"].concat(nuxt ? nuxt.scanEntries : []);
        config.optimizeDeps = { ...optimizeDeps, entries, ...(include ? { include } : {}) };
      },
    },
    resolveId(id) {
      return id === entryId || id === resolvedEntryId ? resolvedEntryId : undefined;
    },
    load(id) {
      return id === resolvedEntryId ? entryCode(react) : undefined;
    },
    configureServer(viteServer) {
      viteServer.middlewares.use(async (request, response, next) => {
        lastRequest = Date.now();
        const url = new URL(request.url || "/", "http://localhost");
        if (url.pathname === pagePath + "/health") {
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(token);
          return;
        }
        if (url.pathname !== pagePath) {
          next();
          return;
        }
        try {
          if (url.searchParams.get("fresh") === "1") await invalidateModules();
          const html = await viteServer.transformIndexHtml(url.pathname + url.search, pageHtml(), request.originalUrl);
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function displayPath(file) {
  const path = relative(packageDir, file.split("?")[0]);
  return path && !path.startsWith("..") ? path.split(sep).join("/") : file;
}

// Imports that only run on the server mark a Server Component: the page
// says so instead of failing somewhere in Node's or Next's internals.
const serverOnlyModules = new Set(["server-only", "next/cache", "next/headers", "next/og", "next/server"]);
const serverBuiltins = new Set(["async_hooks", "child_process", "cluster", "dgram", "dns", "dns/promises", "fs", "fs/promises", "http2", "inspector", "module", "net", "readline", "repl", "tls", "v8", "worker_threads"]);

function serverOnlyPlugin() {
  const imports = [];
  return {
    name: "blame:server-only",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || importer.includes("/node_modules/")) return undefined;
      if (!serverOnlyModules.has(id) && !serverBuiltins.has(id) && !id.startsWith("node:")) return undefined;
      const key = id + "\n" + importer;
      let index = imports.findIndex((entry) => entry.key === key);
      if (index < 0) index = imports.push({ id, importer, key }) - 1;
      return "\0blame-server-only:" + index;
    },
    load(id) {
      if (!id.startsWith("\0blame-server-only:")) return undefined;
      const entry = imports[Number(id.slice("\0blame-server-only:".length))];
      if (!entry) return undefined;
      const message = displayPath(entry.importer) + " imports " + JSON.stringify(entry.id) + ", which runs only on the server: it is part of a Server Component. " + serverComponentHint;
      return "throw new Error(" + JSON.stringify(message) + ");\nexport {};\n";
    },
  };
}

const nextLinkShim = [
  'import { cloneElement, createElement, forwardRef, isValidElement } from "react";',
  'function hrefText(href) {',
  '  if (typeof href === "string") return href;',
  '  if (!href || typeof href !== "object") return "";',
  '  const query = href.query && typeof href.query === "object" ? new URLSearchParams(href.query).toString() : "";',
  '  const hash = href.hash ? (String(href.hash).startsWith("#") ? href.hash : "#" + href.hash) : "";',
  '  return (href.pathname || "") + (href.search || (query ? "?" + query : "")) + hash;',
  '}',
  '// The anchor Next renders; a click stays on the preview page.',
  'const Link = forwardRef(function Link(props, ref) {',
  '  const { href, as, replace, scroll, shallow, passHref, prefetch, locale, legacyBehavior, onNavigate, children, onClick, ...rest } = props;',
  '  const url = hrefText(as || href);',
  '  const click = (event) => {',
  '    if (onClick) onClick(event);',
  '    event.preventDefault();',
  '  };',
  '  if (legacyBehavior && isValidElement(children)) return cloneElement(children, { href: url, onClick: click, ref });',
  '  return createElement("a", { ...rest, href: url, onClick: click, ref }, children);',
  '});',
  'export default Link;',
  'export function useLinkStatus() {',
  '  return { pending: false };',
  '}',
].join("\n");

const nextImageShim = [
  'import { createElement, forwardRef } from "react";',
  'function imageSource(src) {',
  '  if (src && typeof src === "object") return src.default && typeof src.default === "object" ? src.default : src;',
  '  return { src };',
  '}',
  '// A plain img, loaded eagerly so that full-page captures show every image.',
  'const Image = forwardRef(function Image(props, ref) {',
  '  const { src, width, height, fill, sizes, quality, priority, preload, loading, placeholder, blurDataURL, unoptimized, loader, overrideSrc, onLoadingComplete, style, ...rest } = props;',
  '  const image = imageSource(src);',
  '  const fillStyle = fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {};',
  '  return createElement("img", {',
  '    ...rest,',
  '    ref,',
  '    src: overrideSrc || image.src,',
  '    width: fill ? undefined : width ?? image.width,',
  '    height: fill ? undefined : height ?? image.height,',
  '    sizes,',
  '    loading: "eager",',
  '    decoding: "async",',
  '    "data-nimg": fill ? "fill" : "1",',
  '    style: { color: "transparent", ...fillStyle, ...style },',
  '  });',
  '});',
  'export default Image;',
  'export function getImageProps(props) {',
  '  const image = imageSource(props.src);',
  '  return { props: { alt: props.alt, src: props.overrideSrc || image.src, width: props.width ?? image.width, height: props.height ?? image.height, sizes: props.sizes } };',
  '}',
].join("\n");

const nextNavigationShim = [
  'const ignore = () => undefined;',
  'const router = { back: ignore, forward: ignore, prefetch: ignore, push: ignore, refresh: ignore, replace: ignore };',
  'export class ReadonlyURLSearchParams extends URLSearchParams {}',
  'export const RedirectType = { push: "push", replace: "replace" };',
  'export function useRouter() {',
  '  return router;',
  '}',
  'export function usePathname() {',
  '  return "/";',
  '}',
  'export function useSearchParams() {',
  '  return new ReadonlyURLSearchParams();',
  '}',
  'export function useParams() {',
  '  return {};',
  '}',
  'export function useSelectedLayoutSegment() {',
  '  return null;',
  '}',
  'export function useSelectedLayoutSegments() {',
  '  return [];',
  '}',
  'export function useServerInsertedHTML() {}',
  'export function unstable_rethrow() {}',
  'function navigates(name) {',
  '  return new Error(name + "() navigates in the Next.js app, which the component preview does not run: render the state it leads to instead.");',
  '}',
  'export function redirect() {',
  '  throw navigates("redirect");',
  '}',
  'export function permanentRedirect() {',
  '  throw navigates("permanentRedirect");',
  '}',
  'export function notFound() {',
  '  throw navigates("notFound");',
  '}',
  'export function forbidden() {',
  '  throw navigates("forbidden");',
  '}',
  'export function unauthorized() {',
  '  throw navigates("unauthorized");',
  '}',
].join("\n");

// next/font returns class names for fonts Next self-hosts. Here, Google
// fonts get their family name and a generic fallback (the page loads
// nothing remote), local fonts their own files.
const nextFontRuntime = [
  'let count = 0;',
  'const generic = (family) => (/mono|code/i.test(family) ? "monospace" : /serif/i.test(family) && !/sans/i.test(family) ? "serif" : "sans-serif");',
  'function register(family, options, faces) {',
  '  count += 1;',
  '  const className = "__blame_font_" + count;',
  '  const variableClass = "__blame_font_variable_" + count;',
  '  const stack = [JSON.stringify(family)].concat(options.fallback || [generic(family)]).join(", ");',
  '  const weight = typeof options.weight === "string" && !options.weight.includes(" ") ? options.weight : undefined;',
  '  const fontStyle = typeof options.style === "string" ? options.style : undefined;',
  '  const rules = faces.concat("." + className + " { font-family: " + stack + ";" + (weight ? " font-weight: " + weight + ";" : "") + (fontStyle ? " font-style: " + fontStyle + ";" : "") + " }");',
  '  if (options.variable) rules.push("." + variableClass + " { " + options.variable + ": " + stack + "; }");',
  '  const element = document.createElement("style");',
  '  element.dataset.blameFont = family;',
  '  element.textContent = rules.join(" ");',
  '  document.head.appendChild(element);',
  '  const style = { fontFamily: stack };',
  '  if (weight) style.fontWeight = Number(weight) || weight;',
  '  if (fontStyle) style.fontStyle = fontStyle;',
  '  return options.variable ? { className, style, variable: variableClass } : { className, style };',
  '}',
  'export function googleFont(family) {',
  '  return (options) => register(family, options || {}, []);',
  '}',
  'let localCount = 0;',
  'export function localFont(base) {',
  '  return (options) => {',
  '    const settings = options || {};',
  '    localCount += 1;',
  '    const family = "__blame_local_font_" + localCount;',
  '    const sources = Array.isArray(settings.src) ? settings.src : [{ path: settings.src, style: settings.style, weight: settings.weight }];',
  '    const faces = sources.filter((source) => source && source.path).map((source) =>',
  '      "@font-face { font-family: " + JSON.stringify(family) + "; src: url(" + JSON.stringify(new URL(source.path, location.origin + base).pathname) + "); font-display: " + (settings.display || "swap") + ";" + (source.weight ? " font-weight: " + source.weight + ";" : "") + (source.style ? " font-style: " + source.style + ";" : "") + " }");',
  '    return register(family, { fallback: settings.fallback || ["sans-serif"], variable: settings.variable }, faces);',
  '  };',
  '}',
].join("\n");

// The fonts a module imports from next/font/google, read from its source:
// Next requires named imports called with literal options.
function googleFontNames(importer) {
  let source = "";
  try {
    source = readFileSync(importer.split("?")[0], "utf8");
  } catch {
    return [];
  }
  const names = new Set();
  const pattern = /import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source))
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  return [...names];
}

// The URL folder of a module, for the files a local font names.
function moduleBase(importer) {
  const directory = dirname(importer.split("?")[0]);
  const path = relative(packageDir, directory).split(sep).join("/");
  if (!path) return "/";
  if (!path.startsWith("..")) return "/" + path + "/";
  return "/@fs/" + directory.split(sep).join("/").replace(/^\/+/, "") + "/";
}

const nextShimModules = { "next/image": nextImageShim, "next/link": nextLinkShim, "next/navigation": nextNavigationShim };

// Resolves next/link, next/image, next/navigation and next/font/* to the
// shims, for the project's modules and the libraries Vite pre-bundles.
function nextShims() {
  const fontImporters = [];
  return {
    name: "blame:next-shims",
    resolveId(id, importer) {
      const bare = id.replace(/\.js$/, "");
      if (nextShimModules[bare]) return "\0blame-next:" + bare;
      if (id === "blame-next:font-runtime") return "\0blame-next:font-runtime";
      if (bare !== "next/font/google" && bare !== "next/font/local") return undefined;
      let index = fontImporters.indexOf(importer || "");
      if (index < 0) index = fontImporters.push(importer || "") - 1;
      return "\0blame-next:" + bare + ":" + index;
    },
    load(id) {
      if (!id.startsWith("\0blame-next:")) return undefined;
      const name = id.slice("\0blame-next:".length);
      if (nextShimModules[name]) return nextShimModules[name];
      if (name === "font-runtime") return nextFontRuntime;
      const font = /^next\/font\/(google|local):(\d+)$/.exec(name);
      if (!font) return undefined;
      const importer = fontImporters[Number(font[2])] || "";
      if (font[1] === "local")
        return 'import { localFont } from "blame-next:font-runtime";\nexport default localFont(' + JSON.stringify(moduleBase(importer || join(packageDir, "index.js"))) + ");\n";
      return ['import { googleFont } from "blame-next:font-runtime";']
        .concat(googleFontNames(importer).map((exported) => "export const " + exported + " = googleFont(" + JSON.stringify(exported.replace(/_/g, " ")) + ");"))
        .join("\n");
    },
  };
}

// Next inlines the NEXT_PUBLIC_* variables of its .env files in client
// code, Vue CLI its VUE_APP_* ones. In development, Vite's client sets
// defines as globals, so process.env exists in the page as it does there.
function publicEnvDefines(loadEnv, prefix, defines) {
  for (const [key, value] of Object.entries(loadEnv("development", packageDir, prefix)))
    defines["process.env." + key] = JSON.stringify(value);
  return defines;
}

// TypeScript reads jsconfig.json when a folder has no tsconfig.json; Vite
// only finds tsconfig.json by itself.
function jsconfigFile() {
  if (existsSync(join(packageDir, "tsconfig.json"))) return undefined;
  const path = join(packageDir, "jsconfig.json");
  return existsSync(path) ? path : undefined;
}

// Nuxt: what Nuxt generates at build time, rebuilt for the browser.
// unimport, which Nuxt itself uses, auto-imports Vue's API, the shims below
// and the exports of composables/ and utils/; the components of
// components/ resolve by the names Nuxt gives them; ~ and @ point to the
// srcDir. Composables that need the Nuxt server fail with a message.
const nuxtConfigNames = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.cts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs"];
const nuxtAppConfigNames = ["app.config.ts", "app.config.mts", "app.config.js", "app.config.mjs"];
const postcssConfigNames = [".postcssrc", ".postcssrc.json", ".postcssrc.yaml", ".postcssrc.yml", ".postcssrc.js", ".postcssrc.cjs", ".postcssrc.mjs", ".postcssrc.ts", "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs", "postcss.config.ts", "postcss.config.mts", "postcss.config.cts"];
const nuxtPropsHint = "pass made-up data to the component through its props instead.";
const componentExtensions = new Set([".vue", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const nuxtImageComponents = new Set(["NuxtImg", "NuxtPicture"]);
// The flags Nuxt replaces at build time, as they are in the browser.
const nuxtRuntimeFlags = { browser: "true", client: "true", dev: "true", nitro: "false", prerender: "false", server: "false" };
const nuxtRuntimeFlagPattern = /(?<![.\w$])(?:import\.meta|process)\.(browser|client|dev|nitro|prerender|server)\b/g;
// A component a compiled template or render function resolves by name.
const resolveComponentPattern = /(?<=[\s(=,])_?resolveComponent\(\s*(["'\x60])([^"'\x60]+)\1[^)]*\)/g;
const nuxtTsconfigContent = JSON.stringify({ compilerOptions: { allowJs: true, jsx: "preserve", jsxImportSource: "vue", module: "ESNext", moduleResolution: "Bundler", target: "ESNext", useDefineForClassFields: true } }, null, 2) + "\n";

function firstLine(error) {
  return String((error && error.message) || error).split("\n")[0];
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function slashed(path) {
  return path.split(sep).join("/");
}

// Paths with their real paths: Vite names modules by the real one, such as
// /private/var/... for /var/... on macOS.
function withRealPaths(paths) {
  const all = new Set(paths);
  for (const path of paths) {
    try {
      all.add(realpathSync(path));
    } catch {
      // A folder the package does not have.
    }
  }
  return [...all];
}

// scule's splitByCase and pascalCase, with which Nuxt names components.
function splitByCase(text) {
  const parts = [];
  if (!text) return parts;
  let buffer = "";
  let previousUpper;
  let previousSplitter;
  for (const char of text) {
    const splitter = "-_/.".includes(char);
    if (splitter) {
      parts.push(buffer);
      buffer = "";
      previousUpper = undefined;
      continue;
    }
    const upper = /\d/.test(char) ? undefined : char !== char.toLowerCase();
    if (previousSplitter === false) {
      if (previousUpper === false && upper === true) {
        parts.push(buffer);
        buffer = char;
        previousUpper = upper;
        continue;
      }
      if (previousUpper === true && upper === false && buffer.length > 1) {
        const last = buffer.slice(-1);
        parts.push(buffer.slice(0, -1));
        buffer = last + char;
        previousUpper = upper;
        continue;
      }
    }
    buffer += char;
    previousUpper = upper;
    previousSplitter = splitter;
  }
  parts.push(buffer);
  return parts;
}

function pascalCase(parts) {
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

// Nuxt's resolveComponentNameSegments: a folder the file name repeats
// counts once, so components/base/BaseButton.vue is BaseButton, as is
// components/base/Button.vue. Grouping folders such as (forms) add nothing.
function componentNameSegments(fileName, prefixParts) {
  const fileParts = splitByCase(fileName);
  const fileContent = fileParts.join("/").toLowerCase();
  const prefixes = prefixParts.filter((part) => !/^\(.*\)$/.test(part.trim()));
  const nameParts = prefixes.flatMap((part) => splitByCase(part));
  const matched = [];
  for (let index = prefixes.length - 1; index >= 0; index -= 1) {
    const part = prefixes[index];
    matched.unshift(...splitByCase(part).map((segment) => segment.toLowerCase()));
    const matchedContent = matched.join("/");
    if (fileContent === matchedContent || fileContent.startsWith(matchedContent + "/") || (part.toLowerCase() === fileContent && prefixes[index + 1] === part)) nameParts.length = index;
  }
  return nameParts.concat(fileParts);
}

// A folder of nuxt.config, with Nuxt's ~ and @ (srcDir), ~~ and @@ (the
// package) aliases, relative to base otherwise.
function nuxtAliasPath(value, srcDir, base) {
  if (/^(?:~~|@@)(?=\/|$)/.test(value)) return resolve(packageDir, "." + value.slice(2));
  if (/^[~@](?=\/|$)/.test(value)) return resolve(srcDir, "." + value.slice(1));
  return resolve(base, value);
}

// What a nuxt.config or app.config exports, evaluated by Vite as Nuxt
// evaluates it, with defineNuxtConfig or defineAppConfig returning its
// argument. A file Vite cannot load leaves Nuxt's defaults.
async function loadNuxtFile(loadConfigFromFile, directory, names, helper) {
  const file = names.map((name) => join(directory, name)).find((path) => existsSync(path));
  if (!file) return { value: {} };
  if (typeof globalThis[helper] !== "function") globalThis[helper] = (value) => value;
  try {
    const loaded = await loadConfigFromFile({ command: "serve", isPreview: false, isSsrBuild: false, mode: "development" }, file, packageDir, "silent");
    return { file, value: plainObject(loaded && loaded.config) };
  } catch (error) {
    return { error: firstLine(error), file, value: {} };
  }
}

// The installed Nuxt's major version, else the declared one; latest is 4.
function nuxtMajor(require) {
  try {
    return parseInt(JSON.parse(readFileSync(require.resolve("nuxt/package.json"), "utf8")).version, 10) || 4;
  } catch {
    const major = /^\s*[\^~>=v\s]*(\d+)/.exec(dependencyRanges().get("nuxt") || "");
    return major ? Number(major[1]) : 4;
  }
}

// Nuxt 4's srcDir is app/, unless the package still has Nuxt 3's layout;
// Nuxt 3's is the package itself.
function nuxtSourceDirectory(config, major) {
  if (typeof config.srcDir === "string" && config.srcDir) return resolve(packageDir, config.srcDir);
  const app = join(packageDir, "app");
  if ((major < 4 && plainObject(config.future).compatibilityVersion !== 4) || !isDirectory(app)) return packageDir;
  const files = readdirSync(app).filter((name) => name !== "spa-loading-template.html" && !name.startsWith("router.options"));
  if (files.length) return app;
  const legacy = ["app.vue", "App.vue", "assets", "layouts", "middleware", "pages", "plugins"].some((name) => existsSync(join(packageDir, name)));
  return legacy ? packageDir : app;
}

// Nuxt's component folders, deepest first: by default components/global/,
// whose files take no prefix, then components/; else those nuxt.config
// lists. Islands render only on the server.
function nuxtComponentDirectories(option, srcDir) {
  if (option === false) return [];
  const listed = Array.isArray(option) ? option : Array.isArray(plainObject(option).dirs) ? option.dirs : undefined;
  if (!listed) return [{ path: join(srcDir, "components", "global") }, { path: join(srcDir, "components") }];
  return listed
    .map((entry) => (typeof entry === "string" ? { path: entry } : plainObject(entry)))
    .filter((entry) => typeof entry.path === "string" && entry.enabled !== false && !entry.island)
    .map((entry) => ({ path: nuxtAliasPath(entry.path, srcDir, srcDir), pathPrefix: entry.pathPrefix, prefix: typeof entry.prefix === "string" ? entry.prefix : "" }))
    .sort((first, second) => second.path.split(sep).length - first.path.split(sep).length);
}

// The component files of a folder, relative to it and sorted, without the
// files Nuxt ignores, such as tests, stories and preview files.
function componentFiles(root) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") visit(path);
      } else if (entry.isFile() && componentExtensions.has(extname(entry.name)) && !entry.name.startsWith("-") && !/\.d\.[cm]?ts$|\.(?:stories|spec|test)\.[cm]?[jt]sx?$|\.blame-preview\.|(?:M|\.m|-m)ixin\.[jt]sx?$/.test(entry.name)) {
        files.push(relative(root, path));
      }
    }
  };
  visit(root);
  return files.sort();
}

// The components Nuxt registers, by name, as its scanner names them. A
// file of a folder scanned before, such as components/global/, keeps the
// name it got there; the first component of a name wins.
function scanNuxtComponents(directories, skipped) {
  const components = new Map();
  const scanned = [...skipped];
  for (const directory of directories) {
    for (const file of componentFiles(directory.path)) {
      const path = join(directory.path, file);
      if (scanned.some((done) => path.startsWith(done + sep))) continue;
      let name = basename(file, extname(file));
      if (/\.island(?:\.global)?$/.test(name) || /\.server(?:\.global|\.island)*$/.test(name)) continue;
      name = name.replace(/(?:\.(?:client|server))?(?:\.global|\.island)*$/, "");
      if (name.toLowerCase() === "index") name = directory.pathPrefix === false ? basename(dirname(path)) : "";
      const folder = slashed(relative(directory.path, dirname(path)));
      const prefixParts = splitByCase(directory.prefix || "").concat(directory.pathPrefix === false ? [] : splitByCase(folder));
      const pascal = pascalCase(componentNameSegments(name.replace(/["']/g, ""), prefixParts));
      if (pascal && !components.has(pascal)) components.set(pascal, path);
    }
    scanned.push(directory.path);
  }
  return components;
}

// Nuxt configures PostCSS in nuxt.config rather than in a PostCSS config
// file; a config file of the package wins, as Vite loads it by itself.
async function nuxtPostcss(config, require, notes) {
  if (packageManifest().postcss || postcssConfigNames.some((name) => existsSync(join(packageDir, name)))) return undefined;
  const plugins = [];
  for (const [name, options] of Object.entries(plainObject(plainObject(config.postcss).plugins))) {
    if (options === false) continue;
    try {
      const module = await import(pathToFileURL(require.resolve(name)).href);
      const plugin = module.default || module;
      plugins.push(typeof plugin === "function" ? plugin(plainObject(options)) : plugin);
    } catch (error) {
      notes.push("The PostCSS plugin " + name + " of nuxt.config did not load: " + firstLine(error) + ".");
    }
  }
  return plugins.length ? { postcss: { plugins } } : undefined;
}

// Nuxt's tsconfig.json extends or references files nuxi writes in .nuxt/:
// until "nuxi prepare" or "nuxt dev" has run, Vite cannot load it and fails
// every TypeScript module. Then this one, in Blame's toolkit folder, stands
// in for it.
function nuxtTsconfig(toolkitDir) {
  let text;
  try {
    text = readFileSync(join(packageDir, "tsconfig.json"), "utf8");
  } catch {
    return undefined;
  }
  const generated = [...text.matchAll(/["']((?:\.\/)?\.nuxt\/[^"']+)["']/g)].map((match) => join(packageDir, match[1]));
  if (generated.every((path) => existsSync(path))) return undefined;
  const path = join(toolkitDir, "nuxt-tsconfig.json");
  if (!existsSync(path) || readFileSync(path, "utf8") !== nuxtTsconfigContent) {
    const staging = path + "." + process.pid + ".tmp";
    writeFileSync(staging, nuxtTsconfigContent);
    renameSync(staging, path);
  }
  return path;
}

// The Nuxt app of the package: its folders, settings and the notes the
// agent gets about them.
async function nuxtProject(viteApi, require, toolkitDir) {
  const notes = [];
  const nuxtFile = await loadNuxtFile(viteApi.loadConfigFromFile, packageDir, nuxtConfigNames, "defineNuxtConfig");
  const config = nuxtFile.value;
  const major = nuxtMajor(require);
  const srcDir = nuxtSourceDirectory(config, major);
  const appFile = await loadNuxtFile(viteApi.loadConfigFromFile, srcDir, nuxtAppConfigNames, "defineAppConfig");
  if (nuxtFile.error) notes.push("Blame could not read " + basename(nuxtFile.file) + " (" + nuxtFile.error + "): useRuntimeConfig().public is empty and its other settings do not apply.");
  if (appFile.error) notes.push("Blame could not read " + displayPath(appFile.file) + " (" + appFile.error + "): useAppConfig() is empty.");
  notes.push("~/ and @/ resolve to " + (srcDir === packageDir ? "the package folder" : displayPath(srcDir) + "/") + ".");
  const css = (Array.isArray(config.css) ? config.css : []).filter((entry) => typeof entry === "string");
  if (css.length) notes.push("Its nuxt.config's css field lists " + css.join(", ") + ": import " + (css.length === 1 ? "it" : "them") + " in the preview file.");
  const imports = plainObject(config.imports);
  const listedImportDirs = (Array.isArray(imports.dirs) ? imports.dirs : []).filter((entry) => typeof entry === "string").map((entry) => nuxtAliasPath(entry, srcDir, srcDir));
  const defaultImportDirs = [join(srcDir, "composables"), join(srcDir, "utils")];
  const dir = plainObject(config.dir);
  const publicBase = major >= 4 ? packageDir : srcDir;
  const modules = Array.isArray(config.modules) ? config.modules : [];
  return {
    appConfig: appFile.value,
    autoImport: imports.autoImport !== false,
    componentDirs: nuxtComponentDirectories(config.components, srcDir),
    components: undefined,
    config,
    css: await nuxtPostcss(config, require, notes),
    image: dependencyRanges().has("@nuxt/image") || modules.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === "@nuxt/image"),
    importDirs: defaultImportDirs.concat([join(packageDir, "shared", "utils"), join(packageDir, "shared", "types")], listedImportDirs),
    notes,
    publicConfig: plainObject(plainObject(config.runtimeConfig).public),
    publicDir: typeof dir.public === "string" ? resolve(publicBase, dir.public) : join(publicBase, "public"),
    scanEntries: defaultImportDirs.map((path) => relative(packageDir, path)).filter((path) => !path.startsWith("..") && !isAbsolute(path)).map((path) => slashed(path) + "/*.{js,mjs,ts,mts}"),
    serverDirs: withRealPaths([typeof config.serverDir === "string" ? resolve(packageDir, config.serverDir) : join(publicBase, "server"), join(packageDir, "server"), join(srcDir, "server")]),
    srcDir,
    tsconfig: nuxtTsconfig(toolkitDir),
  };
}

// The composables Nuxt provides, as the preview needs them: the route is
// "/", navigation stays on the page, the head is not rendered, and data the
// Nuxt server would fetch fails with a message.
function nuxtAppShim(nuxt) {
  return [
    'import { defineComponent, reactive, ref } from "vue";',
    'const ignore = () => undefined;',
    'const done = () => Promise.resolve();',
    '// "/" with no params, unless the preview file sets others before mounting, such as Object.assign(useRoute().params, { id: "42" }).',
    'const route = reactive({ fullPath: "/", hash: "", href: "/", matched: [], meta: {}, name: "index", params: {}, path: "/", query: {}, redirectedFrom: undefined });',
    'function location(to) {',
    '  if (typeof to === "string") return to;',
    '  if (!to || typeof to !== "object") return "/";',
    '  const query = to.query && typeof to.query === "object" ? new URLSearchParams(to.query).toString() : "";',
    '  return (to.path || "/") + (query ? "?" + query : "") + (to.hash || "");',
    '}',
    'const router = {',
    '  addRoute: () => ignore,',
    '  afterEach: () => ignore,',
    '  back: ignore,',
    '  beforeEach: () => ignore,',
    '  beforeResolve: () => ignore,',
    '  currentRoute: ref(route),',
    '  forward: ignore,',
    '  getRoutes: () => [],',
    '  go: ignore,',
    '  hasRoute: () => false,',
    '  isReady: done,',
    '  onError: () => ignore,',
    '  options: {},',
    '  push: done,',
    '  removeRoute: ignore,',
    '  replace: done,',
    '  resolve(to) {',
    '    const href = location(to);',
    '    return { ...route, fullPath: href, href, path: href.split(/[?#]/)[0] };',
    '  },',
    '};',
    'export function useRoute() {',
    '  return route;',
    '}',
    'export function useRouter() {',
    '  return router;',
    '}',
    'export function navigateTo() {',
    '  return Promise.resolve();',
    '}',
    'export function abortNavigation() {}',
    'export function addRouteMiddleware() {}',
    'export function defineNuxtRouteMiddleware(middleware) {',
    '  return middleware;',
    '}',
    'export function definePageMeta() {}',
    'export function onBeforeRouteLeave() {}',
    'export function onBeforeRouteUpdate() {}',
    'export function setPageLayout() {}',
    'const head = { dispose: ignore, patch: ignore };',
    'export function useHead() {',
    '  return head;',
    '}',
    'export const useHeadSafe = useHead;',
    'export const useSeoMeta = useHead;',
    'export const useServerHead = useHead;',
    'export const useServerHeadSafe = useHead;',
    'export const useServerSeoMeta = useHead;',
    '// The public part of runtimeConfig in nuxt.config, never the rest.',
    'const runtimeConfig = { app: { baseURL: "/", buildAssetsDir: "/_nuxt/", cdnURL: "" }, public: ' + JSON.stringify(nuxt.publicConfig) + ' };',
    'export function useRuntimeConfig() {',
    '  return runtimeConfig;',
    '}',
    'const appConfig = reactive(' + JSON.stringify(nuxt.appConfig) + ');',
    'export function useAppConfig() {',
    '  return appConfig;',
    '}',
    'export function updateAppConfig(values) {',
    '  Object.assign(appConfig, values);',
    '}',
    '// One ref per key, shared by every component, as in Nuxt.',
    'const states = new Map();',
    'export function useState(key, init) {',
    '  if (typeof key === "function") return ref(key());',
    '  if (!states.has(key)) states.set(key, ref(typeof init === "function" ? init() : undefined));',
    '  return states.get(key);',
    '}',
    'export function clearNuxtState(keys) {',
    '  for (const key of keys === undefined ? [...states.keys()] : [].concat(keys)) states.delete(key);',
    '}',
    'const cookies = new Map();',
    'export function useCookie(name, options) {',
    '  if (!cookies.has(name)) cookies.set(name, ref(options && typeof options.default === "function" ? options.default() : undefined));',
    '  return cookies.get(name);',
    '}',
    'export function refreshCookie() {}',
    'const nuxtApp = {',
    '  $config: runtimeConfig,',
    '  $router: router,',
    '  callHook: done,',
    '  hook: () => ignore,',
    '  hooks: { callHook: done, hook: () => ignore },',
    '  isHydrating: false,',
    '  payload: { data: {}, state: {} },',
    '  provide(name, value) {',
    '    nuxtApp["$" + name] = value;',
    '  },',
    '  runWithContext: (callback) => callback(),',
    '};',
    'export function useNuxtApp() {',
    '  return nuxtApp;',
    '}',
    'export const tryUseNuxtApp = useNuxtApp;',
    'export function defineNuxtPlugin(plugin) {',
    '  return plugin;',
    '}',
    'export function defineNuxtComponent(options) {',
    '  return defineComponent(options);',
    '}',
    'export function onNuxtReady(callback) {',
    '  setTimeout(callback);',
    '}',
    'export function callOnce(key, callback) {',
    '  return Promise.resolve((typeof key === "function" ? key : callback)());',
    '}',
    'export function useRequestURL() {',
    '  return new URL(route.fullPath, window.location.origin);',
    '}',
    'export function useRequestHeaders() {',
    '  return {};',
    '}',
    'export function useRequestEvent() {}',
    'export function isPrerendered() {',
    '  return false;',
    '}',
    'export function reloadNuxtApp() {}',
    'export function preloadComponents() {',
    '  return Promise.resolve();',
    '}',
    'export const prefetchComponents = preloadComponents;',
    'export const preloadRouteComponents = preloadComponents;',
    'export function prerenderRoutes() {}',
    'export function setResponseStatus() {}',
    'export function useLoadingIndicator() {',
    '  return { clear: ignore, error: ref(false), finish: ignore, isLoading: ref(false), progress: ref(0), set: ignore, start: ignore };',
    '}',
    'const nuxtError = ref(undefined);',
    'export function createError(input) {',
    '  const details = typeof input === "string" ? { message: input } : input || {};',
    '  return Object.assign(new Error(details.message || details.statusMessage || ""), details, { __nuxt_error: true });',
    '}',
    'export function isNuxtError(value) {',
    '  return Boolean(value && value.__nuxt_error);',
    '}',
    'export function useError() {',
    '  return nuxtError;',
    '}',
    'export function showError(input) {',
    '  nuxtError.value = createError(input);',
    '  return nuxtError.value;',
    '}',
    'export function clearError() {',
    '  nuxtError.value = undefined;',
    '  return Promise.resolve();',
    '}',
    'function serverData(name) {',
    '  return new Error(name + "() fetches data from the Nuxt server, which open_component_preview does not run: " + ' + JSON.stringify(nuxtPropsHint) + ');',
    '}',
    'export function useFetch() {',
    '  throw serverData("useFetch");',
    '}',
    'export function useLazyFetch() {',
    '  throw serverData("useLazyFetch");',
    '}',
    'export function useAsyncData() {',
    '  throw serverData("useAsyncData");',
    '}',
    'export function useLazyAsyncData() {',
    '  throw serverData("useLazyAsyncData");',
    '}',
    'export function $fetch() {',
    '  throw serverData("$fetch");',
    '}',
    '$fetch.raw = $fetch;',
    '$fetch.create = () => $fetch;',
    'export function useRequestFetch() {',
    '  return $fetch;',
    '}',
    'export function useNuxtData() {',
    '  return { data: ref(undefined) };',
    '}',
    'export function refreshNuxtData() {',
    '  return Promise.resolve();',
    '}',
    'export function clearNuxtData() {}',
  ].join("\n");
}

const nuxtAppShimNames = [...nuxtAppShim({ appConfig: {}, publicConfig: {} }).matchAll(/^export (?:function|const) ([\w$]+)/gm)].map((match) => match[1]);

// The components Nuxt provides. A link renders its anchor and does not
// navigate; an @nuxt/image picture loads its source from public/.
const nuxtComponentsShim = [
  'import { computed, defineComponent, h } from "vue";',
  'import { useRoute } from "blame-nuxt:app";',
  'const slot = (name) => defineComponent({ name, setup: (props, { slots }) => () => (slots.default ? slots.default() : null) });',
  'const empty = (name) => defineComponent({ name, setup: () => () => null });',
  'export const ClientOnly = slot("ClientOnly");',
  'export const DevOnly = slot("DevOnly");',
  'export const NuxtClientFallback = slot("NuxtClientFallback");',
  'export const NuxtErrorBoundary = slot("NuxtErrorBoundary");',
  'export const NuxtLayout = slot("NuxtLayout");',
  'export const NuxtLoadingIndicator = empty("NuxtLoadingIndicator");',
  'export const NuxtPage = empty("NuxtPage");',
  'export const NuxtRouteAnnouncer = empty("NuxtRouteAnnouncer");',
  'function hrefText(to) {',
  '  if (typeof to === "string") return to;',
  '  if (!to || typeof to !== "object") return "";',
  '  const query = to.query && typeof to.query === "object" ? new URLSearchParams(to.query).toString() : "";',
  '  const hash = to.hash ? (String(to.hash).startsWith("#") ? to.hash : "#" + to.hash) : "";',
  '  return (to.path || "") + (query ? "?" + query : "") + hash;',
  '}',
  'export const NuxtLink = defineComponent({',
  '  name: "NuxtLink",',
  '  props: {',
  '    activeClass: String,',
  '    ariaCurrentValue: { type: String, default: "page" },',
  '    custom: Boolean,',
  '    exactActiveClass: String,',
  '    external: Boolean,',
  '    href: [String, Object],',
  '    noPrefetch: Boolean,',
  '    noRel: Boolean,',
  '    prefetch: { type: Boolean, default: undefined },',
  '    prefetchOn: [String, Object],',
  '    prefetchedClass: String,',
  '    rel: String,',
  '    replace: Boolean,',
  '    target: String,',
  '    to: [String, Object],',
  '    trailingSlash: String,',
  '  },',
  '  setup(props, { slots }) {',
  '    const route = useRoute();',
  '    const href = computed(() => hrefText(props.to === undefined ? props.href : props.to));',
  '    const external = computed(() => props.external || href.value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href.value));',
  '    const active = computed(() => !external.value && href.value !== "" && href.value.split(/[?#]/)[0] === route.path);',
  '    const navigate = (event) => {',
  '      if (event && event.preventDefault) event.preventDefault();',
  '      return Promise.resolve();',
  '    };',
  '    return () => {',
  '      const rel = props.noRel ? undefined : props.rel || (external.value ? "noopener noreferrer" : undefined);',
  '      if (props.custom) return slots.default ? slots.default({ href: href.value, isActive: active.value, isExactActive: active.value, isExternal: external.value, navigate, rel, route, target: props.target }) : null;',
  '      const classes = active.value ? [props.activeClass || "router-link-active", props.exactActiveClass || "router-link-exact-active"] : undefined;',
  '      return h("a", { "aria-current": active.value ? props.ariaCurrentValue : undefined, class: classes, href: href.value || undefined, onClick: navigate, rel, target: props.target }, slots.default ? slots.default() : undefined);',
  '    };',
  '  },',
  '});',
  'const imageProps = { alt: String, background: String, crossorigin: [Boolean, String], custom: Boolean, decoding: String, densities: String, fetchpriority: String, fit: String, format: String, height: [String, Number], legacyFormat: String, loading: String, modifiers: Object, nonce: String, placeholder: [Boolean, String, Number, Array], placeholderClass: String, preload: [Boolean, Object], preset: String, provider: String, quality: [String, Number], sizes: [String, Object], src: String, width: [String, Number] };',
  '// Loaded eagerly so that full-page captures show every image.',
  'function imageAttributes(props) {',
  '  return { alt: props.alt, crossorigin: props.crossorigin === true ? "anonymous" : props.crossorigin || undefined, decoding: "async", height: props.height, loading: "eager", sizes: typeof props.sizes === "string" ? props.sizes : undefined, src: props.src, width: props.width };',
  '}',
  'export const NuxtImg = defineComponent({',
  '  name: "NuxtImg",',
  '  props: imageProps,',
  '  setup(props, { slots }) {',
  '    return () => {',
  '      const attributes = imageAttributes(props);',
  '      if (props.custom) return slots.default ? slots.default({ imgAttrs: attributes, isLoaded: true, src: props.src }) : null;',
  '      return h("img", attributes);',
  '    };',
  '  },',
  '});',
  'export const NuxtPicture = defineComponent({',
  '  name: "NuxtPicture",',
  '  inheritAttrs: false,',
  '  props: { ...imageProps, imgAttrs: Object },',
  '  setup(props, { attrs }) {',
  '    return () => h("picture", null, [h("img", { ...props.imgAttrs, ...attrs, ...imageAttributes(props) })]);',
  '  },',
  '});',
].join("\n");

const nuxtShimComponentNames = [...nuxtComponentsShim.matchAll(/^export const ([\w$]+)/gm)].map((match) => match[1]);

function nuxtComponents(nuxt) {
  if (!nuxt.components) nuxt.components = scanNuxtComponents(nuxt.componentDirs, [join(nuxt.srcDir, "components", "islands")]);
  return nuxt.components;
}

function nuxtShimAvailable(nuxt, name) {
  return nuxtShimComponentNames.includes(name) && (nuxt.image || !nuxtImageComponents.has(name));
}

// The component a template names, as Nuxt resolves it: the project's
// first, then Nuxt's own. A Lazy prefix loads the same component.
function nuxtComponent(nuxt, rawName) {
  const components = nuxtComponents(nuxt);
  const name = pascalCase(splitByCase(rawName.replace(/["']/g, "")));
  for (const candidate of [name, name.replace(/^Lazy(?=[A-Z])/, "")]) {
    const file = components.get(candidate);
    if (file) return { exported: "default", from: slashed(file) };
    if (nuxtShimAvailable(nuxt, candidate)) return { exported: candidate, from: "blame-nuxt:components" };
  }
  return undefined;
}

// #components, which Nuxt generates.
function nuxtComponentsIndex(nuxt) {
  const exported = new Set();
  const lines = [];
  for (const [name, file] of nuxtComponents(nuxt)) {
    const names = [name, "Lazy" + name].filter((alias) => !exported.has(alias));
    names.forEach((alias) => exported.add(alias));
    if (names.length) lines.push("export { " + names.map((alias) => "default as " + alias).join(", ") + " } from " + JSON.stringify(slashed(file)) + ";");
  }
  const shims = nuxtShimComponentNames.filter((name) => !exported.has(name) && nuxtShimAvailable(nuxt, name));
  if (shims.length) lines.push("export { " + shims.join(", ") + " } from " + JSON.stringify("blame-nuxt:components") + ";");
  return lines.join("\n") + "\n";
}

// The files an import of the project may point to, once Vite has replaced
// its aliases.
function importTargets(id, importer) {
  const path = id.split("?")[0];
  if (path.startsWith(".")) return [resolve(dirname(importer.split("?")[0]), path)];
  if (path.startsWith("/")) return [resolve(path), join(packageDir, path)];
  return isAbsolute(path) ? [path] : [];
}

// Nuxt's virtual modules, and the server/ folder: a component that imports
// it fails with a message instead of running Nitro code in the browser.
function nuxtResolvePlugin(nuxt, unimport) {
  const serverImports = [];
  return {
    name: "blame:nuxt",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === "blame-nuxt:app" || id === "#app" || id.startsWith("#app/") || id === "nuxt/app") return "\0blame-nuxt:app";
      if (id === "blame-nuxt:components") return "\0blame-nuxt:components";
      // No # in these ids: the browser would take it for a URL fragment.
      if (id === "#components") return "\0blame-nuxt:components-index";
      if (id === "#imports") return "\0blame-nuxt:imports";
      if (!importer || importer.startsWith("\0") || importer.includes("/node_modules/")) return undefined;
      const target = importTargets(id, importer).find((path) => nuxt.serverDirs.some((directory) => path === directory || path.startsWith(directory + sep)));
      if (!target) return undefined;
      let index = serverImports.findIndex((entry) => entry.id === id && entry.importer === importer);
      if (index < 0) index = serverImports.push({ id, importer, target }) - 1;
      return "\0blame-nuxt:server:" + index;
    },
    async load(id) {
      if (id === "\0blame-nuxt:app") return nuxtAppShim(nuxt);
      if (id === "\0blame-nuxt:components") return nuxtComponentsShim;
      if (id === "\0blame-nuxt:components-index") return nuxtComponentsIndex(nuxt);
      if (id === "\0blame-nuxt:imports") return (await unimport.toExports()) + "\n";
      if (!id.startsWith("\0blame-nuxt:server:")) return undefined;
      const entry = serverImports[Number(id.slice("\0blame-nuxt:server:".length))];
      if (!entry) return undefined;
      // Vite has replaced its aliases, such as ~~/server/: the file says it.
      const message = displayPath(entry.importer) + " imports " + displayPath(entry.target) + ", which is part of the Nuxt server and never runs in the browser: " + nuxtPropsHint;
      return "throw new Error(" + JSON.stringify(message) + ");\nexport {};\n";
    },
  };
}

// After @vitejs/plugin-vue: unimport adds the imports of the names a
// module uses without importing them, components resolve to their files,
// and Nuxt's flags become constants.
function nuxtTransformPlugin(nuxt, unimport, ready) {
  return {
    name: "blame:nuxt-imports",
    enforce: "post",
    async transform(code, id) {
      const [path, query = ""] = id.split("?");
      // A ?raw or ?url import is a string, and a style block CSS.
      if (id.startsWith("\0") || path.includes("/node_modules/") || !/\.(?:vue|[cm]?[jt]sx?)$/.test(path) || /(?:^|&)(?:type=style\b|raw(?:&|$)|url(?:&|$))/.test(query)) return undefined;
      await ready;
      const { s } = await unimport.injectImports(code, id, { autoImport: nuxt.autoImport });
      for (const match of code.matchAll(nuxtRuntimeFlagPattern)) s.overwrite(match.index, match.index + match[0].length, nuxtRuntimeFlags[match[1]]);
      const locals = new Map();
      for (const match of code.matchAll(resolveComponentPattern)) {
        const component = nuxtComponent(nuxt, match[2]);
        if (!component) continue;
        const key = component.from + "#" + component.exported;
        let local = locals.get(key);
        if (!local) {
          local = "__blame_nuxt_component_" + locals.size;
          locals.set(key, local);
          // Imports are hoisted: appended, they leave every line in place.
          s.append("\nimport " + (component.exported === "default" ? local : "{ " + component.exported + " as " + local + " }") + " from " + JSON.stringify(component.from) + ";");
        }
        s.overwrite(match.index, match.index + match[0].length, local);
      }
      if (!s.hasChanged()) return undefined;
      return { code: s.toString(), map: s.generateMap({ hires: true, includeContent: true, source: path }) };
    },
  };
}

// @vitejs/plugin-vue with the options of nuxt.config, unimport configured
// as Nuxt configures it, and the plugins above.
function nuxtPlugins(modules, nuxt) {
  const viteVue = plainObject(plainObject(nuxt.config.vite).vue);
  const template = plainObject(viteVue.template);
  const compilerOptions = { ...plainObject(plainObject(nuxt.config.vue).compilerOptions), ...plainObject(template.compilerOptions) };
  const vue = modules["@vitejs/plugin-vue"].default({ ...viteVue, template: { ...template, compilerOptions } });
  const unimport = modules.unimport.createUnimport({
    addons: { vueTemplate: true },
    dirs: nuxt.importDirs,
    imports: nuxtAppShimNames.map((name) => ({ from: "blame-nuxt:app", name })),
    presets: ["vue"],
    virtualImports: ["#imports"],
  });
  const ready = unimport.init();
  // Awaited by every transform, which reports a failure.
  ready.catch(() => undefined);
  refreshProjectScan = async () => {
    nuxt.components = undefined;
    await ready;
    await unimport.scanImportsFromDir();
  };
  return [nuxtResolvePlugin(nuxt, unimport), vue, nuxtTransformPlugin(nuxt, unimport, ready)];
}

// Nuxt's aliases: those of nuxt.config first, then ~ and @ for the srcDir,
// ~~ and @@ for the package, and the folders Nuxt names. A @scope/package
// import is never one of them.
function nuxtAliases(nuxt) {
  const pathAlias = /^(?:\.|~|@@|@(?=\/|$))/;
  const own = Object.entries(plainObject(nuxt.config.alias))
    .filter(([, value]) => typeof value === "string")
    .map(([find, value]) => ({ find, replacement: pathAlias.test(value) ? slashed(nuxtAliasPath(value, nuxt.srcDir, packageDir)) : value }));
  return own.concat([
    { find: /^(?:~~|@@)(?=\/|$)/, replacement: slashed(packageDir) },
    { find: /^[~@](?=\/|$)/, replacement: slashed(nuxt.srcDir) },
    { find: /^assets(?=\/|$)/, replacement: slashed(join(nuxt.srcDir, "assets")) },
    { find: /^public(?=\/|$)/, replacement: slashed(nuxt.publicDir) },
    { find: /^#shared(?=\/|$)/, replacement: slashed(join(packageDir, "shared")) },
    { find: /^#server(?=\/|$)/, replacement: slashed(nuxt.serverDirs[0]) },
  ]);
}

// The Vite options of a Nuxt package: its aliases, public folder and
// PostCSS plugins, then the plugins, css, define, json and assetsInclude
// of nuxt.config's vite field, such as @tailwindcss/vite.
function nuxtViteOptions(mergeConfig, options, nuxt) {
  const settings = {
    ...options,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    publicDir: nuxt.publicDir,
    resolve: { alias: nuxtAliases(nuxt) },
    ...(nuxt.css ? { css: nuxt.css } : {}),
    // @vitejs/plugin-vue compiles TypeScript with the oxc options only.
    ...(nuxt.tsconfig ? { oxc: { tsconfig: nuxt.tsconfig }, tsconfig: nuxt.tsconfig } : {}),
  };
  const vite = plainObject(nuxt.config.vite);
  const extra = {};
  for (const key of ["assetsInclude", "css", "define", "json", "plugins"]) if (vite[key] !== undefined) extra[key] = vite[key];
  return mergeConfig(settings, extra);
}

// Blame's own Vite and the packages the framework needs, installed for
// this environment if they are not yet.
async function loadToolkit() {
  const directory = toolkitDirectory();
  const installed = !toolkitReady(directory);
  if (installed) {
    report({ event: "installing", directory });
    await installToolkit(directory);
  }
  const modules = {};
  for (const { name } of toolkitPackages) modules[name] = await import(packageModule(join(directory, "node_modules", ...name.split("/"), "package.json")).url);
  return { modules, toolkit: { directory, installed }, vite: packageModule(join(directory, "node_modules", "vite", "package.json")) };
}

function frameworkPlugins(modules, nuxt) {
  if (framework === "nuxt") return nuxtPlugins(modules, nuxt);
  if (framework === "vue") return [modules["@vitejs/plugin-vue"].default()];
  const plugins = [serverOnlyPlugin(), modules["@vitejs/plugin-react"].default()];
  if (framework === "next") plugins.push({ ...nextShims(), enforce: "pre" });
  return plugins;
}

async function main() {
  // Tailwind and PostCSS find their sources and config from here, as when
  // the package's own dev server runs.
  process.chdir(packageDir);
  const require = createRequire(join(packageDir, "package.json"));
  // A Vue or Nuxt package renders through mount, even with React installed
  // nearby.
  const react = !vueFramework && resolvable(require, "react") && resolvable(require, "react-dom/client");
  let modules;
  let toolkit;
  let vite;
  if (usesToolkit) {
    if (vueFramework) checkVue(require);
    else if (!react) throw new SetupError("React is not installed for " + packageDir + ". Without a Vite config, open_component_preview renders React components only, and it never installs the project's dependencies: install them first.");
    ({ modules, toolkit, vite } = await loadToolkit());
  } else {
    try {
      vite = packageModule(require.resolve("vite/package.json"));
    } catch (error) {
      throw new SetupError("Vite is not installed for " + packageDir + ": " + ((error && error.message) || error));
    }
  }
  const viteApi = await import(vite.url);
  const { createServer, loadEnv } = viteApi;
  const nuxt = framework === "nuxt" ? await nuxtProject(viteApi, require, toolkit.directory) : undefined;
  const plugins = [previewPlugin(react, nuxt)].concat(usesToolkit ? frameworkPlugins(modules, nuxt) : []);
  let options = { root: packageDir, mode: "development", logLevel: "warn", clearScreen: false, plugins };
  if (nuxt) options = nuxtViteOptions(viteApi.mergeConfig, options, nuxt);
  else if (usesToolkit) {
    options.configFile = false;
    options.resolve = { tsconfigPaths: true };
    const jsconfig = jsconfigFile();
    if (jsconfig) options.tsconfig = jsconfig;
    if (framework === "next") {
      options.define = publicEnvDefines(loadEnv, "NEXT_PUBLIC_", { "process.env.NODE_ENV": JSON.stringify("development") });
      options.optimizeDeps = { rolldownOptions: { plugins: [nextShims()] } };
    }
    if (framework === "vue" && dependencyRanges().has("@vue/cli-service")) {
      // Vue CLI's webpack config resolves @ to src, ahead of any path.
      options.resolve.alias = [{ find: /^@\//, replacement: join(packageDir, "src") + sep }];
      options.define = publicEnvDefines(loadEnv, "VUE_APP_", { "process.env.BASE_URL": JSON.stringify("/"), "process.env.NODE_ENV": JSON.stringify("development") });
    }
  }
  server = await createServer(options);
  await server.listen();
  const address = server.httpServer && server.httpServer.address();
  report({ event: "listening", ...(nuxt ? { notes: nuxt.notes } : {}), port: address && typeof address === "object" ? address.port : Number(portText), react, vite: vite.version, ...(toolkit ? { toolkit } : {}) });
  setInterval(() => {
    if (Date.now() - lastRequest > idleMs) close();
  }, 15000).unref();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, close);
main().catch((error) => {
  report({ event: "error", message: error instanceof SetupError ? error.message : String((error && (error.stack || error.message)) || error) });
  process.exit(1);
});
`;
