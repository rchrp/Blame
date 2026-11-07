// The Next.js shims of the temporary component preview server: next/link,
// next/image, next/navigation and next/font only work inside Next, so a
// Next.js app served by Blame's own Vite gets small replacements, in this
// server only.
//
// componentPreviewServerScript appends this script to its own, before the
// call that starts the server: it uses that script's imports and helpers.
// No template expressions and no backticks inside.

export const componentPreviewNextScript = String.raw`
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
`;
