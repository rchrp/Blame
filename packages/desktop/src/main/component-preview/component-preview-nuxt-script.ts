// The Nuxt part of the temporary component preview server. A Nuxt 3 or 4
// package gets Blame's own Vite with @vitejs/plugin-vue and what Nuxt
// generates at build time: auto-imports with unimport, its components by
// their Nuxt names, its aliases, and shims for the composables and
// components Nuxt provides.
//
// componentPreviewServerScript appends this script to its own, before the
// call that starts the server: it uses that script's imports and helpers.
// No template expressions and no backticks inside.

export const componentPreviewNuxtScript = String.raw`
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
`;
