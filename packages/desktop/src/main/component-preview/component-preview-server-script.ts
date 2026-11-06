// The temporary Vite server behind open_component_preview. Blame passes
// this module to `node -e`, so nothing is written to the project. It loads
// the project's own Vite with the config of the package that holds the
// preview file (aliases, plugins, CSS), serves a generated page and entry,
// pre-bundles only what the preview files import, and stops by itself when
// nobody has asked it anything for a while.
//
// A React, Vue 3 or Svelte 5 package without Vite, such as a Next.js, Vue
// CLI or Rollup app, gets Blame's own Vite instead, with
// @vitejs/plugin-react, @vitejs/plugin-vue or @sveltejs/vite-plugin-svelte,
// installed once per environment in the host's toolkit folder, outside the
// worktree. The framework and every other import still resolve from the
// project's node_modules, and the project's own Svelte compiles its
// components; its PostCSS config and tsconfig or jsconfig paths apply.
// Next.js imports that only work inside Next are replaced by small shims,
// and a Vue CLI package keeps its @ alias for src, in this server only.
//
// A SvelteKit app keeps its own Vite and sveltekit(), whose client router
// never starts in the preview page: $app/state (and $app/stores before
// SvelteKit 3) give a page at /, and the page carries the public
// environment variables SvelteKit's own page would, in this server only.

export const componentPreviewPagePath = "/__blame_component_preview__";
export const componentPreviewReportPrefix = "BLAME_COMPONENT_PREVIEW ";

// The versions of Blame's own Vite, the same as Blame's packages use.
export const componentPreviewToolkitVersions = {
  pluginReact: "6.1.2",
  pluginSvelte: "7.3.1",
  pluginVue: "6.0.10",
  vite: "8.3.5",
} as const;

export type ComponentPreviewToolkit = {
  // "next" adds the Next.js shims to React; "vue" uses @vitejs/plugin-vue,
  // "svelte" @sveltejs/vite-plugin-svelte.
  framework: "next" | "react" | "svelte" | "vue";
  // Folder of Blame's own Vite installs, as the server process sees it.
  root: string;
};

// The one Vite plugin a framework needs. Each plugin gets its own toolkit
// folder, so a plugin is only installed for a project that needs it.
export function componentPreviewToolkitPlugin(
  framework: ComponentPreviewToolkit["framework"],
) {
  if (framework === "vue")
    return {
      name: "@vitejs/plugin-vue",
      version: componentPreviewToolkitVersions.pluginVue,
    };
  if (framework === "svelte")
    return {
      name: "@sveltejs/vite-plugin-svelte",
      version: componentPreviewToolkitVersions.pluginSvelte,
    };
  return {
    name: "@vitejs/plugin-react",
    version: componentPreviewToolkitVersions.pluginReact,
  };
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
  const plugin = toolkit && componentPreviewToolkitPlugin(toolkit.framework);
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
    plugin?.name ?? "",
    plugin?.version ?? "",
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
      return {
        event: "listening",
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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodeModule, { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, host, portText, token, idleText, cacheName, toolkitRoot, toolkitVite, toolkitPlugin, toolkitPluginVersion, framework] = process.argv.slice(1);
const pagePath = "/__blame_component_preview__/" + token;
const entryId = "virtual:blame-component-preview";
const resolvedEntryId = "\0" + entryId;
const idleMs = Number(idleText) || 660000;
const usesToolkit = Boolean(toolkitVite);
const serverComponentHint = "open_component_preview renders client components in the browser: preview one of its client sub-components with made-up props, or check this screen in the full app.";
const vueMountHint = "A preview file of a Vue package exports mount(element, state), which renders the named state into element, such as createApp(Component, props).mount(element).";
const svelteMountHint = "A preview file of a Svelte package exports mount(element, state), which renders the named state into element, such as mount(Component, { target: element, props }) with mount from svelte.";
// Vue and Svelte packages served by Blame's Vite render every state
// through mount.
const mountHints = { svelte: svelteMountHint, vue: vueMountHint };
// Set for a SvelteKit app: the major version of its @sveltejs/kit.
let svelteKitMajor = 0;
let lastRequest = Date.now();
let server;
let closing = false;

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

// The packages the package's own package.json declares.
function ownDependencies() {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return new Set(["dependencies", "devDependencies"].flatMap((field) => Object.keys(manifest[field] || {})));
  } catch {
    return new Set();
  }
}

// The version of a package installed for the package, or undefined.
function projectVersion(require, name) {
  try {
    return String(JSON.parse(readFileSync(require.resolve(name + "/package.json"), "utf8")).version || "");
  } catch {
    return undefined;
  }
}

function versionParts(version) {
  return version.split(".").map((part) => parseInt(part, 10) || 0);
}

function versionBelow(version, minimum) {
  const parts = versionParts(version);
  const index = minimum.findIndex((part, position) => (parts[position] || 0) !== part);
  return index >= 0 && (parts[index] || 0) < minimum[index];
}

// The framework Blame's Vite compiles with: the project's own, at least the
// version the plugin requires.
function checkFramework(require, framework) {
  const { label, minimum, name, plugin } =
    framework === "vue"
      ? { label: "Vue", minimum: [3, 2, 25], name: "vue", plugin: "@vitejs/plugin-vue" }
      : { label: "Svelte", minimum: [5, 46, 4], name: "svelte", plugin: "@sveltejs/vite-plugin-svelte" };
  const version = projectVersion(require, name);
  if (version === undefined) throw new SetupError(label + " is not installed for " + packageDir + ". open_component_preview never installs the project's dependencies: install them first.");
  const supported = label + " " + minimum.join(".") + " or later";
  const [major] = versionParts(version);
  if (major < minimum[0]) throw new SetupError(label + " " + major + " is not supported: " + packageDir + " has " + name + " " + version + " installed, and without a Vite config open_component_preview renders " + supported + " only. Check this component in the app instead.");
  if (versionBelow(version, minimum)) throw new SetupError(name + " " + version + " is installed for " + packageDir + ": without a Vite config, open_component_preview renders " + supported + " only, which " + plugin + " requires. Check this component in the app instead.");
}

// @sveltejs/vite-plugin-svelte imports svelte/compiler from its own folder.
// Its imports of svelte resolve from the package instead: the project's
// own Svelte compiles the components that its runtime renders. A require()
// keeps its own parent whatever the hook passes on: the package's require
// resolves it.
function useProjectSvelte(require) {
  if (typeof nodeModule.registerHooks !== "function") throw new SetupError("Node " + process.version + " runs " + packageDir + ": without a Vite config, open_component_preview renders Svelte components with Node 22.15 or later only. Check this component in the app instead.");
  const parentURL = pathToFileURL(join(packageDir, "package.json")).href;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const svelte = specifier === "svelte" || specifier.startsWith("svelte/");
      const fromPlugin = Boolean(context.parentURL && context.parentURL.includes("/node_modules/@sveltejs/vite-plugin-svelte/"));
      if (!svelte || !fromPlugin) return nextResolve(specifier, context);
      if (context.conditions && context.conditions.includes("require")) return { shortCircuit: true, url: pathToFileURL(require.resolve(specifier)).href };
      return nextResolve(specifier, { ...context, parentURL });
    },
  });
}

// A package's own Svelte config, which @sveltejs/vite-plugin-svelte loads.
function svelteConfigFile() {
  return ["svelte.config.js", "svelte.config.mjs", "svelte.config.cjs", "svelte.config.ts", "svelte.config.mts"].some((name) => existsSync(join(packageDir, name)));
}

// Blame's own Vite: one install per version, platform and C library, so a
// container and the runtime can share the folder, with the one plugin the
// package needs.
function toolkitDirectory() {
  const header = process.platform === "linux" && process.report ? process.report.getReport().header : undefined;
  const libc = process.platform !== "linux" ? "" : header && header.glibcVersionRuntime ? "-gnu" : "-musl";
  const root = toolkitRoot || join(homedir(), ".cache", "blame", "component-preview");
  return join(root, "vite-" + toolkitVite + "-" + toolkitPlugin.replace(/^@[^/]+\//, "") + "-" + toolkitPluginVersion + "-" + process.platform + "-" + process.arch + libc);
}

function installedVersion(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function toolkitReady(directory) {
  return installedVersion(directory, "vite") === toolkitVite && installedVersion(directory, toolkitPlugin) === toolkitPluginVersion;
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
    const manifest = { name: "blame-component-preview-vite", private: true, dependencies: { vite: toolkitVite, [toolkitPlugin]: toolkitPluginVersion } };
    writeFileSync(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await runNpm(["install", "--no-package-lock", "--ignore-scripts", "--loglevel=error", "--cache", join(parent, ".npm-cache")], staging);
    if (!toolkitReady(staging)) throw new Error("npm finished without installing vite " + toolkitVite + " and " + toolkitPlugin + " " + toolkitPluginVersion + ".");
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

function pageHtml(head) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Component preview</title>' + head + "</head>",
    '<body><div id="root"></div><script type="module" src="/@id/__x00__' + entryId + '"></script></body>',
    "</html>",
  ].join("\n");
}

// mountHint: how the package's framework renders through mount, when
// React is not installed.
function entryCode(react, mountHint) {
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
  if (mountHints[framework])
    lines.push(
      '  } else {',
      '    finish("error", ' + JSON.stringify(mountHints[framework]) + ' + " Its exports: " + (names.join(", ") || "none") + ".");',
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
        '    finish("error", "React is not installed for this package: export mount(element, state) to render " + JSON.stringify(state) + "."' + (mountHint ? ' + " " + ' + JSON.stringify(mountHint) : "") + ');',
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

function invalidateModules() {
  const graphs = server.environments
    ? Object.values(server.environments).map((environment) => environment.moduleGraph)
    : [server.moduleGraph];
  for (const graph of graphs) if (graph && typeof graph.invalidateAll === "function") graph.invalidateAll();
}

function previewPlugin(react, mountHint) {
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
        // re-optimization and its reload.
        const frameworkDeps = framework === "vue" ? ["vue"] : react ? ["react", "react-dom/client", "react/jsx-dev-runtime"] : [];
        const include = frameworkDeps.length ? [...new Set([...(optimizeDeps.include || []), ...frameworkDeps])] : optimizeDeps.include;
        config.optimizeDeps = { ...optimizeDeps, entries: ["**/*.blame-preview.*"], ...(include ? { include } : {}) };
      },
    },
    resolveId(id) {
      return id === entryId || id === resolvedEntryId ? resolvedEntryId : undefined;
    },
    load(id) {
      return id === resolvedEntryId ? entryCode(react, mountHint) : undefined;
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
          if (url.searchParams.get("fresh") === "1") invalidateModules();
          const head = svelteKitMajor ? await svelteKitHead(viteServer) : "";
          const html = await viteServer.transformIndexHtml(url.pathname + url.search, pageHtml(head), request.originalUrl);
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

// $app/state as SvelteKit's router leaves it after it navigates to /: the
// preview page has no router. The preview file may change the page before
// it mounts, such as page.url or page.params.
const svelteKitStateShim = [
  'export const page = { data: {}, error: null, form: null, params: {}, route: { id: null }, state: {}, status: 200, url: new URL("/", location.origin) };',
  'export const navigating = { from: null, to: null, type: null, willUnload: null, delta: null, complete: null };',
  'export const updated = { current: false, check: async () => false };',
].join("\n");

// $app/stores, removed in SvelteKit 3, with the same page.
const svelteKitStoresShim = [
  'import { readable } from "svelte/store";',
  'import { page as pageState } from "blame-sveltekit:state";',
  'export const page = readable(pageState);',
  'export const navigating = readable(null);',
  'export const updated = { ...readable(false), check: async () => false };',
  'export function getStores() {',
  '  return { page, navigating, updated };',
  '}',
].join("\n");

// Resolves $app/state, and $app/stores before SvelteKit 3, to the shims,
// ahead of SvelteKit's own $app alias.
function svelteKitShims() {
  const shims = { state: svelteKitStateShim, ...(svelteKitMajor < 3 ? { stores: svelteKitStoresShim } : {}) };
  return {
    name: "blame:sveltekit-shims",
    enforce: "pre",
    config: {
      order: "post",
      handler(config) {
        const alias = (config.resolve && config.resolve.alias) || [];
        const entries = Array.isArray(alias) ? alias : Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
        const shimEntries = Object.keys(shims).map((name) => ({ find: new RegExp("^\\$app/" + name + "$"), replacement: "blame-sveltekit:" + name }));
        config.resolve = { ...(config.resolve || {}), alias: [...shimEntries, ...entries] };
      },
    },
    resolveId(id) {
      return id.startsWith("blame-sveltekit:") && shims[id.slice("blame-sveltekit:".length)] ? "\0" + id : undefined;
    },
    load(id) {
      return id.startsWith("\0blame-sveltekit:") ? shims[id.slice("\0blame-sveltekit:".length)] : undefined;
    },
  };
}

// SvelteKit 3, and SvelteKit 2 with explicit environment variables, give
// the public ones of src/env.* through $app/env/public; SvelteKit 2
// otherwise gives its PUBLIC_* ones through $env/dynamic/public.
function explicitSvelteKitEnv(viteServer) {
  if (svelteKitMajor >= 3) return true;
  const setup = viteServer.config.plugins.find((plugin) => plugin.name === "vite-plugin-sveltekit-setup");
  const kit = setup && setup.api && setup.api.options && setup.api.options.kit;
  return Boolean(kit && kit.experimental && kit.experimental.explicitEnvironmentVariables);
}

// What SvelteKit's own page sets before its modules run: the dynamic
// public environment variables, read from SvelteKit's server modules, which
// never give the private ones.
async function svelteKitHead(viteServer) {
  let script;
  try {
    const env = explicitSvelteKitEnv(viteServer)
      ? { ...(await viteServer.ssrLoadModule("$app/env/public")) }
      : { ...(await viteServer.ssrLoadModule("$env/dynamic/public")).env };
    script = "globalThis.__sveltekit_dev = " + JSON.stringify({ env }) + ";";
  } catch (error) {
    const message = "SvelteKit did not give the public environment variables of " + packageDir + ": " + ((error && error.message) || error);
    script = 'document.documentElement.dataset.blamePreviewStatus = "error";\ndocument.documentElement.dataset.blamePreviewMessage = ' + JSON.stringify(message) + ";";
  }
  return "<script>" + script.replace(/</g, "\\u003c") + "</script>";
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

// Blame's own Vite with the package's framework plugin, installed for this
// environment if it is not yet.
async function toolkitPlugins(plugins, require) {
  const directory = toolkitDirectory();
  const installed = !toolkitReady(directory);
  if (installed) {
    report({ event: "installing", directory });
    await installToolkit(directory);
  }
  const vite = packageModule(join(directory, "node_modules", "vite", "package.json"));
  if (framework === "svelte") useProjectSvelte(require);
  const plugin = await import(packageModule(join(directory, "node_modules", ...toolkitPlugin.split("/"), "package.json")).url);
  if (framework === "vue") plugins.push(plugin.default());
  // Without a svelte.config.*, <style lang="..."> blocks go through Vite's
  // CSS preprocessors, as svelte-preprocess does in a bundler's config.
  else if (framework === "svelte") plugins.push(...plugin.svelte(svelteConfigFile() ? undefined : { preprocess: plugin.vitePreprocess() }));
  else plugins.push(serverOnlyPlugin(), plugin.default());
  if (framework === "next") plugins.push({ ...nextShims(), enforce: "pre" });
  return { toolkit: { directory, installed }, vite };
}

async function main() {
  // Tailwind and PostCSS find their sources and config from here, as when
  // the package's own dev server runs.
  process.chdir(packageDir);
  const require = createRequire(join(packageDir, "package.json"));
  // A Vue or Svelte package renders through mount, even with React
  // installed nearby.
  const react = !mountHints[framework] && resolvable(require, "react") && resolvable(require, "react-dom/client");
  const mountHint = react ? undefined : mountHints[framework] || (projectVersion(require, "svelte") ? svelteMountHint : projectVersion(require, "vue") ? vueMountHint : undefined);
  const kitVersion = !usesToolkit && ownDependencies().has("@sveltejs/kit") ? projectVersion(require, "@sveltejs/kit") : undefined;
  svelteKitMajor = kitVersion ? versionParts(kitVersion)[0] : 0;
  const plugins = [previewPlugin(react, mountHint), ...(svelteKitMajor ? [svelteKitShims()] : [])];
  let vite;
  let toolkit;
  if (usesToolkit) {
    if (mountHints[framework]) checkFramework(require, framework);
    else if (!react) throw new SetupError("React is not installed for " + packageDir + ". Without a Vite config, open_component_preview renders React components only, and it never installs the project's dependencies: install them first.");
    ({ toolkit, vite } = await toolkitPlugins(plugins, require));
  } else {
    try {
      vite = packageModule(require.resolve("vite/package.json"));
    } catch (error) {
      throw new SetupError("Vite is not installed for " + packageDir + ": " + ((error && error.message) || error));
    }
  }
  const { createServer, loadEnv } = await import(vite.url);
  const options = { root: packageDir, mode: "development", logLevel: "warn", clearScreen: false, plugins };
  if (usesToolkit) {
    options.configFile = false;
    options.resolve = { tsconfigPaths: true };
    const jsconfig = jsconfigFile();
    if (jsconfig) options.tsconfig = jsconfig;
    if (framework === "next") {
      options.define = publicEnvDefines(loadEnv, "NEXT_PUBLIC_", { "process.env.NODE_ENV": JSON.stringify("development") });
      options.optimizeDeps = { rolldownOptions: { plugins: [nextShims()] } };
    }
    if (framework === "vue" && ownDependencies().has("@vue/cli-service")) {
      // Vue CLI's webpack config resolves @ to src, ahead of any path.
      options.resolve.alias = [{ find: /^@\//, replacement: join(packageDir, "src") + sep }];
      options.define = publicEnvDefines(loadEnv, "VUE_APP_", { "process.env.BASE_URL": JSON.stringify("/"), "process.env.NODE_ENV": JSON.stringify("development") });
    }
  }
  server = await createServer(options);
  await server.listen();
  const address = server.httpServer && server.httpServer.address();
  report({ event: "listening", port: address && typeof address === "object" ? address.port : Number(portText), react, vite: vite.version, ...(toolkit ? { toolkit } : {}) });
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
