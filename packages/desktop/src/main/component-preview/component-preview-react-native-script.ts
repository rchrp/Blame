// The React Native part of the temporary component preview server. A
// package with react-native-web, such as an Expo app with web support,
// renders as in its web build: react-native resolves to react-native-web,
// a .web.* file comes before its native variant, and __DEV__ is set. An
// Expo module whose native module or view is missing in the browser fails
// with an error that names it.
//
// componentPreviewServerScript appends this script to its own, before the
// call that starts the server: it uses that script's imports and helpers.
// No template expressions and no backticks inside.

export const componentPreviewReactNativeScript = String.raw`
// The extensions an Expo app's web build tries first, before Vite's own
// and those of its pre-bundler.
const webExtensions = [".web.tsx", ".web.ts", ".web.jsx", ".web.js"];
const viteExtensions = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const preBundlerExtensions = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];

// react-native-web renders the components in the page, with react-dom.
function checkReactNativeWeb(require) {
  const missing = ["react", "react-dom", "react-native-web"].filter((name) => !resolvable(require, name));
  if (!missing.length) return;
  const names = missing.length > 1 ? missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1] + " are" : missing[0] + " is";
  throw new SetupError(names + " not installed for " + packageDir + ". Without a Vite config, open_component_preview renders React Native components with react-native-web and react-dom, and it never installs the project's dependencies: install them first.");
}

// In the browser, an Expo module's requireNativeModule, requireNativeView or
// requireNativeViewManager call throws: its native code is not there. Each
// call of an expo-* package gets a wrapper whose error names the package.
const nativeCallPattern = /(?<![\w$.])(requireNative(?:Module|View|ViewManager))\((?=\s*["'])/g;
const nativeOnlyRuntimeId = "blame-native-only:runtime";
const nativeOnlyRuntime = [
  'export function nativeOnly(name, require) {',
  '  if (typeof require !== "function") return require;',
  '  return function (...args) {',
  '    try {',
  '      return require.apply(this, args);',
  '    } catch (error) {',
  '      const cause = (error && error.message) || String(error);',
  '      throw new Error(name + " has no web implementation (" + cause + "): open_component_preview renders React Native components in the browser with react-native-web. Check this component in the app or on a device, or preview a sub-component that does not use " + name + ".", { cause: error });',
  '    }',
  '  };',
  '}',
].join("\n");

// The expo-* package of a module, from its path: the last node_modules
// folder, as pnpm nests packages. expo-modules-core defines the calls.
function expoPackage(id) {
  const matches = [...id.split("\\").join("/").matchAll(/\/node_modules\/(expo-[^/]+)\//g)];
  const name = matches.length ? matches[matches.length - 1][1] : undefined;
  return name === "expo-modules-core" ? undefined : name;
}

// For the package's modules and those Vite pre-bundles. Only ES modules are
// changed: the runtime's import goes last, so every line stays in place.
function nativeOnlyPlugin() {
  return {
    name: "blame:expo-native-only",
    resolveId(id) {
      return id === nativeOnlyRuntimeId ? "\0" + nativeOnlyRuntimeId : undefined;
    },
    load(id) {
      return id === "\0" + nativeOnlyRuntimeId ? nativeOnlyRuntime : undefined;
    },
    transform(code, id) {
      const name = expoPackage(id);
      if (!name || !/^\s*(?:import|export)\s/m.test(code)) return undefined;
      const wrapped = code.replace(nativeCallPattern, (call, callee) => "__blameNativeOnly(" + JSON.stringify(name) + ", " + callee + ")(");
      if (wrapped === code) return undefined;
      return { code: wrapped + '\nimport { nativeOnly as __blameNativeOnly } from "' + nativeOnlyRuntimeId + '";\n', map: null };
    },
  };
}
`;
