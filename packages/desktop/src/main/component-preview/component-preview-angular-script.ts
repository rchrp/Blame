// The Angular part of the temporary component preview server. An Angular
// package without Vite, such as an Angular CLI app, gets Blame's own Vite
// with @analogjs/vite-plugin-angular, which compiles its components ahead
// of time with the Angular compiler, @angular/build and TypeScript the
// project installed, as `ng serve` does. The page loads the polyfills
// angular.json lists before the preview file: zone.js when they include
// it, otherwise the render is zoneless. Every state renders through
// mount(element, state).
//
// componentPreviewServerScript appends this script to its own: it uses
// that script's imports and helpers, and declares functions only, which
// are hoisted. No template expressions and no backticks inside.

export const componentPreviewAngularScript = String.raw`
// The package's Angular, checked before Blame's Vite is installed, with
// what angular.json says of its application.
function angularSetup(require) {
  const bases = angularResolutionBases(require);
  const version = angularPackageVersion(bases, "@angular/core");
  if (version === undefined) throw new SetupError("Angular is not installed for " + packageDir + ". open_component_preview never installs the project's dependencies: install them first.");
  const major = parseInt(version, 10) || 0;
  if (major < 17 || major > 22) throw new SetupError("@angular/core " + version + " is installed for " + packageDir + ": without a Vite config, open_component_preview renders Angular 17 to 22 only, the versions " + toolkitPlugin + " " + toolkitPluginVersion + " supports. Check this component in the app instead.");
  const builder = major < 18 ? "@angular-devkit/build-angular" : "@angular/build";
  for (const name of ["@angular/compiler-cli", builder, "typescript"])
    if (angularPackageVersion(bases, name) === undefined) throw new SetupError(name + " is not installed for " + packageDir + ": " + toolkitPlugin + " compiles Angular " + major + " components with the project's own " + name + ". open_component_preview never installs the project's dependencies: install them first.");
  if (typeof nodeModule.registerHooks !== "function") throw new SetupError("Angular components need Node 22.15 or later, so that Blame's Vite compiles them with the project's Angular compiler: " + packageDir + " runs Node " + process.versions.node + ". Check this component in the app instead.");
  const { options, problem } = angularBuildOptions();
  const tsconfig = [options.tsConfig, "tsconfig.app.json", "tsconfig.json"]
    .filter((path) => typeof path === "string" && path)
    .map((path) => resolve(packageDir, path))
    .find((path) => existsSync(path));
  if (!tsconfig) throw new SetupError(packageDir + " has no tsconfig for Angular to compile with: angular.json names none that exists, and there is no tsconfig.app.json or tsconfig.json.");
  const polyfills = typeof options.polyfills === "string" ? [options.polyfills] : Array.isArray(options.polyfills) ? options.polyfills : [];
  return {
    bases,
    inlineStyleLanguage: typeof options.inlineStyleLanguage === "string" ? options.inlineStyleLanguage : "css",
    polyfills: polyfills.filter((entry) => typeof entry === "string" && entry).map(angularPolyfill),
    problem,
    tsconfig,
    version,
  };
}

// Where the project's Angular packages resolve from: the package, then
// @angular-devkit/build-angular, whose @angular/build a strict layout such
// as pnpm's keeps out of the package's reach.
function angularResolutionBases(require) {
  const bases = [join(packageDir, "package.json")];
  try {
    bases.push(realpathSync(require.resolve("@angular-devkit/build-angular/package.json")));
  } catch {
    // Not installed: Angular 18 and later only need @angular/build.
  }
  return bases;
}

function angularPackageVersion(bases, name) {
  for (const base of bases) {
    try {
      return String(JSON.parse(readFileSync(createRequire(base).resolve(name + "/package.json"), "utf8")).version || "");
    } catch {
      // Not resolvable from this folder.
    }
  }
  return undefined;
}

// The build options angular.json gives the package's first application.
function angularBuildOptions() {
  const path = join(packageDir, "angular.json");
  if (!existsSync(path)) return { options: {} };
  let workspace;
  try {
    workspace = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { options: {}, problem: "angular.json is not plain JSON (" + ((error && error.message) || error) + "), so its tsconfig and polyfills were not read" };
  }
  const projects = Object.values((workspace && workspace.projects) || {}).filter((project) => project && typeof project === "object");
  const project = projects.find((candidate) => candidate.projectType === "application") || projects[0];
  const targets = (project && (project.architect || project.targets)) || {};
  const options = targets.build && targets.build.options;
  return { options: options && typeof options === "object" ? options : {} };
}

// A polyfill of angular.json: a file of the package, or a module such as
// zone.js.
function angularPolyfill(entry) {
  const path = resolve(packageDir, entry);
  if (!existsSync(path) || !statSync(path).isFile()) return { specifier: entry, zone: /^zone\.js(\/|$)/.test(entry) };
  const file = relative(packageDir, path).split(sep).join("/");
  return {
    specifier: file.startsWith("..") ? "/@fs/" + path.split(sep).join("/").replace(/^\/+/, "") : "/" + file,
    zone: /["']zone\.js["'/]/.test(readFileSync(path, "utf8")),
  };
}

// Analog's plugin imports the Angular compiler, @angular/build and
// TypeScript itself. From Blame's folder, these imports resolve from the
// package instead: the plugin compiles with the project's Angular.
function resolveAngularFromProject(bases, pluginDirectory) {
  const pluginURL = pathToFileURL(realpathSync(pluginDirectory)).href + "/";
  const projectOwned = /^(?:@angular\/|@angular-devkit\/|typescript(?:\/|$))/;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!projectOwned.test(specifier) || !context.parentURL || !context.parentURL.startsWith(pluginURL)) return nextResolve(specifier, context);
      const required = Boolean(context.conditions && context.conditions.includes("require"));
      let failure;
      for (const base of bases) {
        try {
          if (required) return { shortCircuit: true, url: pathToFileURL(createRequire(base).resolve(specifier)).href };
          return nextResolve(specifier, { ...context, parentURL: pathToFileURL(base).href });
        } catch (error) {
          failure = failure || error;
        }
      }
      throw failure;
    },
  });
}

// The plugin compiles only the files of its TypeScript program, and turns
// Vite's own TypeScript transform off: the preview files, which
// tsconfig.app.json does not list, join the program.
function angularPluginOptions(angular) {
  return {
    include: angularPreviewIncludes(),
    inlineStylesExtension: angular.inlineStyleLanguage,
    liveReload: false,
    tsconfig: angular.tsconfig,
    workspaceRoot: packageDir,
  };
}

// Globs, from the package folder, for its preview files: node_modules,
// build output and hidden folders are never crawled.
function angularPreviewIncludes() {
  const skipped = new Set(["build", "coverage", "dist", "node_modules", "out", "tmp"]);
  return ["/*.blame-preview.ts"].concat(
    readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skipped.has(entry.name))
      .map((entry) => "/" + entry.name + "/**/*.blame-preview.ts"),
  );
}

// Bundled up front with the polyfill modules: a first render never waits
// for a re-optimization and its reload.
function angularDependencies(angular) {
  const modules = angular.polyfills.map((polyfill) => polyfill.specifier).filter((specifier) => !specifier.startsWith("/"));
  return ["@angular/core", "@angular/common", "@angular/platform-browser"].concat(modules);
}

// The entry's describe(error) and checks, with what to do for the errors a
// preview file of an Angular package runs into.
function angularHelperLines() {
  const ngModuleHint = "This component is declared in an NgModule: import that module's file in the preview file, create the application with createApplication({ providers: [importProvidersFrom(TheModule)] }), and render the component with createComponent, not bootstrapApplication.";
  const zonelessHint = "The project's polyfills do not include zone.js, so the preview renders zoneless: add provideZonelessChangeDetection() to the providers of createApplication (provideExperimentalZonelessChangeDetection() on Angular 18 and 19; Angular 17 needs zone.js).";
  const routerHint = "This component depends on the router: add provideRouter([]) to the providers of createApplication.";
  return [
    'const ngModuleHint = ' + JSON.stringify(ngModuleHint) + ';',
    'const zonelessHint = ' + JSON.stringify(zonelessHint) + ';',
    'const routerHint = ' + JSON.stringify(routerHint) + ';',
    'const errorText = (error) => (error && (error.message || error.reason)) || String(error);',
    // NG0907: bootstrapApplication of a component an NgModule declares.
    // NG0908: Angular before 21, with neither zone.js nor zoneless change
    // detection. NG0201: no provider, here for the router.
    'const describe = (error) => {',
    '  const text = errorText(error);',
    '  if (text.includes("NG0907")) return ngModuleHint + " Angular reported: " + text;',
    '  if (text.includes("NG0201") && (text.includes("ActivatedRoute") || text.includes("Router"))) return routerHint + " Angular reported: " + text;',
    '  return text.includes("NG0908") ? zonelessHint + " Angular reported: " + text : text;',
    '};',
    // Compiled ahead of time, Angular skips its runtime check of unknown
    // elements: Angular renders nothing for an element no component or
    // directive matched. In a component an NgModule declares, without any
    // dependency, the compiler never saw that module. The ng global holds
    // Angular's development utilities.
    'const unloadedModuleElements = () => {',
    '  const ng = globalThis.ng;',
    '  if (!ng || typeof ng.getOwningComponent !== "function") return [];',
    '  const found = new Set();',
    '  for (const node of element.querySelectorAll("*")) {',
    '    if (!node.localName.includes("-") || node.namespaceURI !== "http://www.w3.org/1999/xhtml" || customElements.get(node.localName)) continue;',
    '    if (ng.getComponent(node) || ng.getDirectives(node).length) continue;',
    '    const owner = ng.getOwningComponent(node);',
    '    const definition = owner && owner.constructor["ɵcmp"];',
    '    if (definition && definition.standalone === false && !definition.directiveDefs && !definition.schemas) found.add("<" + node.localName + "> in the template of " + owner.constructor.name);',
    '  }',
    '  return [...found];',
    '};',
    'const checkModules = () => {',
    '  const unknown = unloadedModuleElements();',
    '  if (unknown.length) finish("error", "Angular rendered nothing for " + unknown.join(", ") + ": no component or directive matched. " + ngModuleHint);',
    '};',
  ];
}

// Imported in order, before the preview file.
function angularPolyfillLines(angular) {
  return angular.polyfills.map((polyfill) => '  await import(' + JSON.stringify(polyfill.specifier) + ');');
}

// What the listening report says of Angular.
function angularReport(angular) {
  return {
    polyfills: angular.polyfills.map((polyfill) => polyfill.specifier),
    ...(angular.problem ? { problem: angular.problem } : {}),
    tsconfig: displayPath(angular.tsconfig),
    version: angular.version,
    zone: angular.polyfills.some((polyfill) => polyfill.zone),
  };
}
`;
