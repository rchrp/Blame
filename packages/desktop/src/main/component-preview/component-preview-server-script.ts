// The temporary Vite server behind open_component_preview. Blame passes
// this module to `node -e`, so nothing is written to the project. It loads
// the project's own Vite with the config of the package that holds the
// preview file (aliases, plugins, CSS), serves a generated page and entry,
// pre-bundles only what the preview files import, and stops by itself when
// nobody has asked it anything for a while.
//
// A React, Vue 3, Svelte 5 or Angular package without Vite, such as a
// Next.js, Vue CLI, Nuxt, Rollup or Angular CLI app, gets Blame's own Vite
// instead, with @vitejs/plugin-react, @vitejs/plugin-vue,
// @sveltejs/vite-plugin-svelte or @analogjs/vite-plugin-angular, installed
// once per environment in the host's toolkit folder, outside the
// worktree. The framework and every other import still resolve from the
// project's node_modules, and the project's own Svelte compiles its
// components; its PostCSS config and tsconfig or jsconfig paths apply.
// Next.js imports that only work inside Next are replaced by small shims,
// and a Vue CLI package keeps its @ alias for src, in this server only. A
// Nuxt package also gets what Nuxt generates at build time: auto-imports
// with unimport, its components by their Nuxt names, its aliases, and shims
// for the composables and components Nuxt provides.
// The Angular part is in component-preview-angular-script.ts.
//
// A React Native package with react-native-web, such as an Expo app with
// web support, renders as in its web build: react-native resolves to
// react-native-web, a .web.* file comes before its native variant, and
// __DEV__ is set. An Expo module whose native module or view is missing in
// the browser fails with an error that names it.
//
// A SvelteKit app keeps its own Vite and sveltekit(), whose client router
// never starts in the preview page: $app/state (and $app/stores before
// SvelteKit 3) give a page at /, and the page carries the public
// environment variables SvelteKit's own page would, in this server only.

import { componentPreviewAngularScript } from "./component-preview-angular-script.ts";
import { componentPreviewNextScript } from "./component-preview-next-script.ts";
import { componentPreviewNuxtScript } from "./component-preview-nuxt-script.ts";
import { componentPreviewReactNativeScript } from "./component-preview-react-native-script.ts";
import { componentPreviewSvelteScript } from "./component-preview-svelte-script.ts";

export const componentPreviewPagePath = "/__blame_component_preview__";
export const componentPreviewReportPrefix = "BLAME_COMPONENT_PREVIEW ";

// The versions of Blame's own Vite, the same as Blame's packages use.
export const componentPreviewToolkitVersions = {
  pluginAngular: "2.9.6",
  pluginReact: "6.1.2",
  pluginSvelte: "7.3.1",
  pluginVue: "6.0.10",
  unimport: "7.0.2",
  vite: "8.3.5",
} as const;

export type ComponentPreviewToolkit = {
  // "next" adds the Next.js shims to React, "react-native" resolves
  // react-native to react-native-web; "vue" uses @vitejs/plugin-vue,
  // "nuxt" adds Nuxt's auto-imports and shims to it, "svelte"
  // @sveltejs/vite-plugin-svelte, "angular" @analogjs/vite-plugin-angular.
  framework:
    "angular" | "next" | "nuxt" | "react" | "react-native" | "svelte" | "vue";
  // Folder of Blame's own Vite installs, as the server process sees it.
  root: string;
};

// The one Vite plugin a framework needs. Each plugin gets its own toolkit
// folder, so a plugin is only installed for a project that needs it.
export function componentPreviewToolkitPlugin(
  framework: ComponentPreviewToolkit["framework"],
) {
  if (framework === "angular")
    return {
      name: "@analogjs/vite-plugin-angular",
      version: componentPreviewToolkitVersions.pluginAngular,
    };
  if (framework === "vue" || framework === "nuxt")
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

type ComponentPreviewToolkitPackage = { name: string; version: string };

// What a framework needs beside Vite, its Vite plugin first. Each set gets
// its own toolkit folder, so a package is only installed for a project
// that needs it.
export function componentPreviewToolkitPackages(
  framework: ComponentPreviewToolkit["framework"],
): ComponentPreviewToolkitPackage[] {
  const plugin = componentPreviewToolkitPlugin(framework);
  return framework === "nuxt"
    ? [
        plugin,
        { name: "unimport", version: componentPreviewToolkitVersions.unimport },
      ]
    : [plugin];
}

// A framework's toolkit folder, before the platform suffix the server adds,
// such as "vite-8.3.5-plugin-vue-6.0.10".
export function componentPreviewToolkitFolder(
  framework: ComponentPreviewToolkit["framework"],
) {
  return [
    `vite-${componentPreviewToolkitVersions.vite}`,
    ...componentPreviewToolkitPackages(framework).map(
      ({ name, version }) => `${name.replace(/^@[^/]+\//u, "")}-${version}`,
    ),
  ].join("-");
}

// What an Angular server compiles with and loads first.
export type ComponentPreviewAngularReport = {
  // The polyfills of angular.json, imported before the preview file.
  polyfills: string[];
  // Why angular.json could not be read, if it could not.
  problem?: string;
  // Relative to the package directory.
  tsconfig: string;
  version: string;
  // Whether the polyfills load zone.js; otherwise the render is zoneless.
  zone: boolean;
};

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
      // Set when Blame's own Vite compiles an Angular package.
      angular?: ComponentPreviewAngularReport;
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
      const angular = angularReport(value.angular);
      const notes = Array.isArray(value.notes)
        ? value.notes.filter((note): note is string => typeof note === "string")
        : [];
      return {
        event: "listening",
        ...(angular ? { angular } : {}),
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

function angularReport(
  value: unknown,
): ComponentPreviewAngularReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as Record<string, unknown>;
  return {
    polyfills: Array.isArray(report.polyfills)
      ? report.polyfills.filter(
          (polyfill): polyfill is string => typeof polyfill === "string",
        )
      : [],
    ...(typeof report.problem === "string" ? { problem: report.problem } : {}),
    tsconfig: typeof report.tsconfig === "string" ? report.tsconfig : "",
    version: typeof report.version === "string" ? report.version : "",
    zone: report.zone === true,
  };
}

// Plain JavaScript run by the project's Node. No template expressions and
// no backticks inside: the script is one String.raw literal, followed by
// its framework parts, then the call that starts the server, once every
// part has declared its constants.
export const componentPreviewServerScript =
  String.raw`
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodeModule, { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, host, portText, token, idleText, cacheName, toolkitRoot, toolkitVite, toolkitFolder, toolkitPackagesText, framework] = process.argv.slice(1);
// The packages beside Vite in Blame's own Vite: [{ name, version }], the
// framework's Vite plugin first.
const toolkitPackages = toolkitPackagesText ? JSON.parse(toolkitPackagesText) : [];
const toolkitPlugin = toolkitPackages.length ? toolkitPackages[0].name : "";
const toolkitPluginVersion = toolkitPackages.length ? toolkitPackages[0].version : "";
const pagePath = "/__blame_component_preview__/" + token;
const entryId = "virtual:blame-component-preview";
const resolvedEntryId = "\0" + entryId;
const idleMs = Number(idleText) || 660000;
const usesToolkit = Boolean(toolkitVite);
const serverComponentHint = "open_component_preview renders client components in the browser: preview one of its client sub-components with made-up props, or check this screen in the full app.";
const vueMountHint = "A preview file of a Vue package exports mount(element, state), which renders the named state into element, such as createApp(Component, props).mount(element).";
const svelteMountHint = "A preview file of a Svelte package exports mount(element, state), which renders the named state into element, such as mount(Component, { target: element, props }) with mount from svelte.";
// Vue, Nuxt, Svelte and Angular packages served by Blame's Vite render
// every state through mount.
const angularMountHint = "A preview file of an Angular package exports mount(element, state), which renders the named state into element: createApplication({ providers }), then createComponent(Component, { environmentInjector: app.injector, hostElement: element }), its inputs set with setInput, app.attachView(ref.hostView) and ref.changeDetectorRef.detectChanges().";
const mountHints = { angular: angularMountHint, nuxt: vueMountHint, svelte: svelteMountHint, vue: vueMountHint };
// Scans the project's folders again before a fresh render, such as Nuxt's
// components and composables.
let refreshProjectScan;
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
// React is not installed; angular: what an Angular package loads first.
function entryCode(react, mountHint, angular) {
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
  );
  if (angular) lines.push(...angularHelperLines());
  else lines.push('const describe = (error) => (error && (error.message || error.reason)) || String(error);');
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
  );
  if (angular) lines.push(...angularPolyfillLines(angular));
  lines.push(
    '  const preview = await import(/* @vite-ignore */ "/" + file.split("/").map(encodeURIComponent).join("/"));',
    '  const names = Object.keys(preview).filter((name) => name !== "mount");',
    '  if (typeof preview.mount === "function") {',
    '    await preview.mount(element, state);',
  );
  if (angular) lines.push('    checkModules();');
  lines.push(
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

async function invalidateModules() {
  if (refreshProjectScan) await refreshProjectScan();
  const graphs = server.environments
    ? Object.values(server.environments).map((environment) => environment.moduleGraph)
    : [server.moduleGraph];
  for (const graph of graphs) if (graph && typeof graph.invalidateAll === "function") graph.invalidateAll();
}

function previewPlugin(react, mountHint, angular, nuxt) {
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
        // The entry imports React itself, a Vue preview file imports Vue,
        // an Angular one Angular, and a React Native one react-native-web
        // through its alias: bundled up front, a first render never waits
        // for a re-optimization and its reload. Nuxt's composables and
        // utils are imported by no file, only auto-imported: scanned too.
        const reactDeps = ["react", "react-dom/client", "react/jsx-dev-runtime", ...(framework === "react-native" ? ["react-native-web"] : [])];
        const frameworkDeps = angular ? angularDependencies(angular) : framework === "vue" || framework === "nuxt" ? ["vue"] : react ? reactDeps : [];
        const include = frameworkDeps.length ? [...new Set([...(optimizeDeps.include || []), ...frameworkDeps])] : optimizeDeps.include;
        const entries = ["**/*.blame-preview.*"].concat(nuxt ? nuxt.scanEntries : []);
        config.optimizeDeps = { ...optimizeDeps, entries, ...(include ? { include } : {}) };
      },
    },
    resolveId(id) {
      return id === entryId || id === resolvedEntryId ? resolvedEntryId : undefined;
    },
    load(id) {
      return id === resolvedEntryId ? entryCode(react, mountHint, angular) : undefined;
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

// Blame's own Vite and the packages the framework needs, installed for
// this environment if they are not yet.
async function loadToolkit(require, angular) {
  const directory = toolkitDirectory();
  const installed = !toolkitReady(directory);
  if (installed) {
    report({ event: "installing", directory });
    await installToolkit(directory);
  }
  if (framework === "svelte") useProjectSvelte(require);
  if (angular) resolveAngularFromProject(angular.bases, join(directory, "node_modules", ...toolkitPlugin.split("/")));
  const modules = {};
  for (const { name } of toolkitPackages) modules[name] = await import(packageModule(join(directory, "node_modules", ...name.split("/"), "package.json")).url);
  return { modules, toolkit: { directory, installed }, vite: packageModule(join(directory, "node_modules", "vite", "package.json")) };
}

function frameworkPlugins(modules, nuxt, angular) {
  if (framework === "nuxt") return nuxtPlugins(modules, nuxt);
  const plugin = modules[toolkitPlugin];
  if (angular) return [plugin.default(angularPluginOptions(angular))];
  if (framework === "vue") return [plugin.default()];
  // Without a svelte.config.*, <style lang="..."> blocks go through Vite's
  // CSS preprocessors, as svelte-preprocess does in a bundler's config.
  if (framework === "svelte") return plugin.svelte(svelteConfigFile() ? undefined : { preprocess: plugin.vitePreprocess() });
  const plugins = [serverOnlyPlugin(), plugin.default()];
  if (framework === "next") plugins.push({ ...nextShims(), enforce: "pre" });
  if (framework === "react-native") plugins.push(nativeOnlyPlugin());
  return plugins;
}

async function main() {
  // Tailwind and PostCSS find their sources and config from here, as when
  // the package's own dev server runs.
  process.chdir(packageDir);
  const require = createRequire(join(packageDir, "package.json"));
  // A Vue, Nuxt, Svelte or Angular package renders through mount, even with
  // React installed nearby.
  const react = !mountHints[framework] && resolvable(require, "react") && resolvable(require, "react-dom/client");
  const mountHint = react ? undefined : mountHints[framework] || (projectVersion(require, "svelte") ? svelteMountHint : projectVersion(require, "vue") ? vueMountHint : undefined);
  const kitVersion = !usesToolkit && dependencyRanges().has("@sveltejs/kit") ? projectVersion(require, "@sveltejs/kit") : undefined;
  svelteKitMajor = kitVersion ? versionParts(kitVersion)[0] : 0;
  const angular = framework === "angular" ? angularSetup(require) : undefined;
  let modules;
  let toolkit;
  let vite;
  if (usesToolkit) {
    if (framework === "vue" || framework === "nuxt") checkFramework(require, "vue");
    else if (framework === "svelte") checkFramework(require, framework);
    else if (framework === "react-native") checkReactNativeWeb(require);
    else if (!angular && !react) throw new SetupError("React is not installed for " + packageDir + ". Without a Vite config, open_component_preview renders React components only, and it never installs the project's dependencies: install them first.");
    ({ modules, toolkit, vite } = await loadToolkit(require, angular));
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
  const plugins = [previewPlugin(react, mountHint, angular, nuxt), ...(svelteKitMajor ? [svelteKitShims()] : [])].concat(usesToolkit ? frameworkPlugins(modules, nuxt, angular) : []);
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
    if (framework === "react-native") {
      // As an Expo app's web build does. The package's own
      // react-native-web serves every module, those of its dependencies
      // included. Expo inlines EXPO_PUBLIC_* variables of its .env files.
      options.resolve.alias = [{ find: /^react-native$/, replacement: "react-native-web" }];
      options.resolve.dedupe = ["react-native-web"];
      options.resolve.extensions = [...webExtensions, ...viteExtensions];
      options.define = publicEnvDefines(loadEnv, "EXPO_PUBLIC_", { __DEV__: "true", "process.env.NODE_ENV": JSON.stringify("development") });
      // Vite's pre-bundler has its own extensions and defines.
      options.optimizeDeps = {
        rolldownOptions: {
          plugins: [nativeOnlyPlugin()],
          resolve: { extensions: [...webExtensions, ...preBundlerExtensions] },
          transform: { define: { __DEV__: "true" } },
        },
      };
    }
  }
  server = await createServer(options);
  await server.listen();
  const address = server.httpServer && server.httpServer.address();
  report({ event: "listening", ...(nuxt ? { notes: nuxt.notes } : {}), port: address && typeof address === "object" ? address.port : Number(portText), react, vite: vite.version, ...(toolkit ? { toolkit } : {}), ...(angular ? { angular: angularReport(angular) } : {}) });
  setInterval(() => {
    if (Date.now() - lastRequest > idleMs) close();
  }, 15000).unref();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, close);
` +
  componentPreviewSvelteScript +
  componentPreviewNextScript +
  componentPreviewReactNativeScript +
  componentPreviewNuxtScript +
  componentPreviewAngularScript +
  String.raw`
main().catch((error) => {
  report({ event: "error", message: error instanceof SetupError ? error.message : String((error && (error.stack || error.message)) || error) });
  process.exit(1);
});
`;
