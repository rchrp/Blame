import * as React from "react"

import { cn } from "@/lib/utils"

type FileIconNode = {
  path: string
  type: "directory" | "file"
}

// Catppuccin's icons (scripts/build-file-icon-sprite.mjs), colored by the
// theme's --ctp-* variables (index.css).
const sprite = new URL("../../file-icons/sprite.svg", import.meta.url).href

const fileNames: Record<string, string> = {
  ".babelrc": "babel",
  ".dockerignore": "docker-ignore",
  ".editorconfig": "editorconfig",
  ".envrc": "envrc",
  ".eslintignore": "eslint-ignore",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitmodules": "git",
  ".node-version": "npm",
  ".npmignore": "npm-ignore",
  ".npmrc": "npm",
  ".nvmrc": "npm",
  ".prettierignore": "prettier-ignore",
  ".vercelignore": "vercel-ignore",
  "angular.json": "angular",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  "bun.lock": "bun-lock",
  "bun.lockb": "bun-lock",
  "bunfig.toml": "bun",
  "cargo.lock": "cargo-lock",
  "cargo.toml": "cargo",
  codeowners: "codeowners",
  "composer.json": "php",
  "contributing.md": "contributing",
  "deno.json": "deno",
  "deno.jsonc": "deno",
  "deno.lock": "deno-lock",
  "favicon.ico": "favicon",
  "go.mod": "go-mod",
  "go.sum": "go-mod",
  makefile: "makefile",
  "package-lock.json": "npm-lock",
  "package.json": "package-json",
  "pnpm-lock.yaml": "pnpm-lock",
  "pnpm-workspace.yaml": "pnpm",
  "pyproject.toml": "python-config",
  "renovate.json": "renovate",
  "requirements.txt": "python",
  "robots.txt": "robots",
  "tauri.conf.json": "tauri",
  "todo.md": "todo",
  "turbo.json": "turbo",
  "uv.lock": "uv",
  "vercel.json": "vercel",
  "wrangler.toml": "wrangler",
  "yarn.lock": "yarn-lock",
}

// Names that keep their icon whatever follows: .env.local, tsconfig.app.json.
const namePrefixes: [string, string][] = [
  [".env", "env"],
  [".eslintrc", "eslint"],
  [".prettierrc", "prettier"],
  ["changelog", "changelog"],
  ["docker-compose", "docker-compose"],
  ["dockerfile", "docker"],
  ["license", "license"],
  ["readme", "readme"],
  ["tsconfig", "typescript-config"],
]

// <tool>.config.<extension>, whatever the extension.
const configFiles: Record<string, string> = {
  astro: "astro-config",
  drizzle: "drizzle-orm",
  eslint: "eslint",
  jest: "jest",
  next: "next",
  nuxt: "nuxt",
  playwright: "playwright",
  postcss: "postcss",
  prettier: "prettier",
  rollup: "rollup",
  svelte: "svelte-config",
  tailwind: "tailwind",
  vite: "vite",
  vitest: "vitest",
  vue: "vue-config",
  webpack: "webpack",
}

const fileExtensions: Record<string, string> = {
  "7z": "zip",
  astro: "astro",
  avi: "video",
  bash: "bash",
  bmp: "image",
  c: "c",
  cfg: "config",
  cjs: "javascript",
  clj: "clojure",
  cljs: "clojure",
  conf: "config",
  cpp: "cpp",
  crt: "certificate",
  cs: "csharp",
  css: "css",
  "css.map": "css-map",
  csv: "csv",
  cts: "typescript",
  "d.ts": "typescript-def",
  dart: "dart",
  db: "database",
  diff: "diff",
  doc: "ms-word",
  docx: "ms-word",
  ejs: "ejs",
  env: "env",
  erl: "erlang",
  ex: "elixir",
  exe: "exe",
  exs: "elixir",
  fish: "bash",
  flac: "audio",
  fs: "fsharp",
  gif: "image",
  gleam: "gleam",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  gz: "zip",
  h: "c-header",
  hbs: "handlebars",
  hpp: "cpp-header",
  hs: "haskell",
  htm: "html",
  html: "html",
  http: "http",
  ico: "favicon",
  ini: "config",
  ipynb: "jupyter",
  java: "java",
  jl: "julia",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  "js.map": "javascript-map",
  json: "json",
  jsonc: "json",
  jsx: "javascript-react",
  key: "key",
  kt: "kotlin",
  less: "less",
  liquid: "liquid",
  lock: "lock",
  log: "log",
  lua: "lua",
  m: "c",
  md: "markdown",
  mdx: "markdown-mdx",
  mjs: "javascript",
  mm: "cpp",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  mts: "typescript",
  nix: "nix",
  otf: "font",
  patch: "diff",
  pdf: "pdf",
  pem: "certificate",
  php: "php",
  png: "image",
  ppt: "ms-powerpoint",
  pptx: "ms-powerpoint",
  prisma: "prisma",
  proto: "proto",
  ps1: "powershell",
  pug: "pug",
  py: "python",
  r: "r",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scala: "scala",
  scss: "sass",
  sh: "bash",
  sol: "solidity",
  "spec.js": "javascript-test",
  "spec.jsx": "javascript-test",
  "spec.ts": "typescript-test",
  "spec.tsx": "typescript-test",
  sql: "database",
  sqlite: "database",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  "test.js": "javascript-test",
  "test.jsx": "javascript-test",
  "test.ts": "typescript-test",
  "test.tsx": "typescript-test",
  tex: "latex",
  tf: "terraform",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript-react",
  ttf: "font",
  txt: "text",
  vb: "visual-studio",
  vim: "vim",
  vue: "vue",
  wasm: "web-assembly",
  wav: "audio",
  webm: "video",
  webp: "image",
  woff: "font",
  woff2: "font",
  xlsx: "ms-excel",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zip: "zip",
  zsh: "bash",
}

const folderNames: Record<string, string> = {
  ".devcontainer": "folder-devcontainer",
  ".git": "folder-git",
  ".github": "folder-github",
  ".gitlab": "folder-gitlab",
  ".husky": "folder-husky",
  ".idea": "folder-intellij",
  ".next": "folder-next",
  ".storybook": "folder-storybook",
  ".turbo": "folder-turbo",
  ".vercel": "folder-vercel",
  ".vscode": "folder-vscode",
  admin: "folder-admin",
  android: "folder-android",
  api: "folder-api",
  app: "folder-app",
  assets: "folder-assets",
  audio: "folder-audio",
  auth: "folder-security",
  build: "folder-dist",
  client: "folder-client",
  common: "folder-shared",
  components: "folder-components",
  composables: "folder-composables",
  config: "folder-config",
  constants: "folder-constant",
  content: "folder-content",
  controllers: "folder-controllers",
  core: "folder-core",
  coverage: "folder-coverage",
  cypress: "folder-cypress",
  data: "folder-database",
  database: "folder-database",
  db: "folder-database",
  dist: "folder-dist",
  docker: "folder-docker",
  docs: "folder-docs",
  e2e: "folder-tests",
  examples: "folder-examples",
  fonts: "folder-fonts",
  functions: "folder-functions",
  graphql: "folder-graphql",
  helpers: "folder-utils",
  hooks: "folder-hooks",
  i18n: "folder-locales",
  icons: "folder-images",
  images: "folder-images",
  img: "folder-images",
  include: "folder-include",
  infra: "folder-cloud",
  jobs: "folder-queue",
  layouts: "folder-layouts",
  lib: "folder-lib",
  locales: "folder-locales",
  messages: "folder-messages",
  middleware: "folder-middleware",
  migrations: "folder-database",
  mocks: "folder-mocks",
  node_modules: "folder-node",
  out: "folder-dist",
  packages: "folder-packages",
  pages: "folder-views",
  plugins: "folder-plugins",
  prisma: "folder-prisma",
  private: "folder-private",
  public: "folder-public",
  queue: "folder-queue",
  routes: "folder-routes",
  script: "folder-scripts",
  scripts: "folder-scripts",
  security: "folder-security",
  server: "folder-server",
  shared: "folder-shared",
  "src-tauri": "folder-tauri",
  src: "folder-src",
  static: "folder-public",
  styles: "folder-styles",
  svg: "folder-svg",
  templates: "folder-templates",
  temp: "folder-temp",
  test: "folder-tests",
  tests: "folder-tests",
  themes: "folder-themes",
  tmp: "folder-temp",
  types: "folder-types",
  upload: "folder-upload",
  uploads: "folder-upload",
  utils: "folder-utils",
  vendor: "folder-packages",
  videos: "folder-video",
  views: "folder-views",
  workflows: "folder-workflows",
}

export function DevelopmentFileIcon({
  className,
  expanded,
  mono,
  node,
}: {
  className?: string
  expanded?: boolean
  mono?: boolean
  node: FileIconNode
}) {
  const icon = iconName(node.path, node.type, Boolean(expanded))
  const maskId = React.useId()

  return (
    <svg className={cn("size-4", className)} data-component="file-icon">
      {mono ? (
        <>
          <defs>
            <mask id={maskId} mask-type="alpha">
              <use href={`${sprite}#${icon}`} />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="currentColor"
            mask={`url(#${maskId})`}
          />
        </>
      ) : (
        <use href={`${sprite}#${icon}`} />
      )}
    </svg>
  )
}

function iconName(path: string, type: FileIconNode["type"], expanded: boolean) {
  const basename = basenameOf(path).toLowerCase()
  if (type === "directory") return folderIconName(basename, expanded)
  return (
    fileNames[basename] ??
    prefixIconName(basename) ??
    configIconName(basename) ??
    extensionIconName(basename) ??
    "file"
  )
}

function folderIconName(name: string, expanded: boolean) {
  const icon =
    folderNames[name] ?? folderNames[name.replace(/^[_.]+/, "")] ?? "folder"
  return expanded ? `${icon}-open` : icon
}

function prefixIconName(name: string) {
  return namePrefixes.find(
    ([prefix]) => name === prefix || name.startsWith(`${prefix}.`)
  )?.[1]
}

function configIconName(name: string) {
  const tool = /^([a-z0-9-]+)\.config\.[a-z]+$/.exec(name)?.[1]
  return tool ? configFiles[tool] : undefined
}

function extensionIconName(name: string) {
  return dottedSuffixes(name)
    .map((extension) => fileExtensions[extension])
    .find(Boolean)
}

function dottedSuffixes(name: string) {
  const suffixes = new Set([name])
  name.split(".").forEach((_, index, parts) => {
    if (index > 0) suffixes.add(parts.slice(index).join("."))
  })
  return [...suffixes].sort((left, right) => right.length - left.length)
}

function basenameOf(path: string) {
  return path.split("\\").join("/").split("/").filter(Boolean).pop() ?? ""
}
