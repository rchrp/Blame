// The temporary Vite server behind open_component_preview. Blame passes
// this module to `node -e`, so nothing is written to the project. It loads
// the project's own Vite with the config of the package that holds the
// preview file (aliases, plugins, CSS), serves a generated page and entry,
// pre-bundles only what the preview files import, and stops by itself when
// nobody has asked it anything for a while.

export const componentPreviewPagePath = "/__blame_component_preview__";
export const componentPreviewReportPrefix = "BLAME_COMPONENT_PREVIEW ";

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
};

export type ComponentPreviewServerReport =
  | { event: "listening"; port: number; react: boolean; vite: string }
  | { event: "error"; message: string };

export function componentPreviewServerArguments(
  options: ComponentPreviewServerOptions,
) {
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
    if (value.event === "listening" && typeof value.port === "number")
      return {
        event: "listening",
        port: value.port,
        react: value.react === true,
        vite: typeof value.vite === "string" ? value.vite : "",
      };
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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, host, portText, token, idleText, cacheName] = process.argv.slice(1);
const pagePath = "/__blame_component_preview__/" + token;
const entryId = "virtual:blame-component-preview";
const resolvedEntryId = "\0" + entryId;
const idleMs = Number(idleText) || 660000;
let lastRequest = Date.now();
let server;
let closing = false;

function report(value) {
  process.stdout.write("BLAME_COMPONENT_PREVIEW " + JSON.stringify(value) + "\n");
}

function close() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 3000).unref();
  Promise.resolve(server && server.close()).catch(() => undefined).finally(() => process.exit(0));
}

function viteModule(require) {
  const manifestPath = require.resolve("vite/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let entry = manifest.exports && manifest.exports["."];
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
    lines.push('import { createElement, isValidElement } from "react";');
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
    'addEventListener("error", (event) => finish("error", event.message || describe(event.error)));',
    'addEventListener("unhandledrejection", (event) => finish("error", describe(event.reason)));',
    'const element = document.getElementById("root");',
    'try {',
    '  const preview = await import(/* @vite-ignore */ "/" + file.split("/").map(encodeURIComponent).join("/"));',
    '  const names = Object.keys(preview).filter((name) => name !== "mount");',
    '  if (typeof preview.mount === "function") {',
    '    await preview.mount(element, state);',
    '    finish("ready");',
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
      '    } else {',
      '      createRoot(element, { onUncaughtError: (error) => { console.error(error); finish("error", describe(error)); } }).render(node);',
      '      finish("ready");',
      '    }',
      '  }',
    );
  else
    lines.push(
      '  } else {',
      '    finish("error", "React is not installed for this package: export mount(element, state) to render " + JSON.stringify(state) + ".");',
      '  }',
    );
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

function previewPlugin(react) {
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
        config.optimizeDeps = { ...(config.optimizeDeps || {}), entries: ["**/*.blame-preview.*"] };
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
          if (url.searchParams.get("fresh") === "1") invalidateModules();
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

async function main() {
  const require = createRequire(join(packageDir, "package.json"));
  let vite;
  try {
    vite = viteModule(require);
  } catch (error) {
    throw new Error("Vite is not installed for " + packageDir + ": " + ((error && error.message) || error));
  }
  const { createServer } = await import(vite.url);
  const react = resolvable(require, "react") && resolvable(require, "react-dom/client");
  server = await createServer({
    root: packageDir,
    mode: "development",
    logLevel: "warn",
    clearScreen: false,
    plugins: [previewPlugin(react)],
  });
  await server.listen();
  const address = server.httpServer && server.httpServer.address();
  report({ event: "listening", port: address && typeof address === "object" ? address.port : Number(portText), react, vite: vite.version });
  setInterval(() => {
    if (Date.now() - lastRequest > idleMs) close();
  }, 15000).unref();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, close);
main().catch((error) => {
  report({ event: "error", message: String((error && (error.stack || error.message)) || error) });
  process.exit(1);
});
`;
