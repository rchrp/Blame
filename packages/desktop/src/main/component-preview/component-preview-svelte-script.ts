// The Svelte and SvelteKit parts of the temporary component preview
// server. A Svelte 5 package without Vite gets Blame's own Vite with
// @sveltejs/vite-plugin-svelte, compiled by the project's own Svelte. A
// SvelteKit app keeps its own Vite and sveltekit(), whose client router never
// starts in the preview page: $app/state (and $app/stores before SvelteKit
// 3) give a page at /, and the page carries the public environment
// variables SvelteKit's own page would.
//
// componentPreviewServerScript appends this script to its own, before the
// call that starts the server: it uses that script's imports and helpers.
// No template expressions and no backticks inside.

export const componentPreviewSvelteScript = String.raw`
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
`;
