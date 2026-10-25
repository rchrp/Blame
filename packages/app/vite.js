import path from "node:path"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import pdfAssets from "./vite-pdf-assets.js"

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL(".", import.meta.url))
const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const reactRuntime = {
  react: require.resolve("react"),
  "react/jsx-runtime": require.resolve("react/jsx-runtime"),
  "react/jsx-dev-runtime": require.resolve("react/jsx-dev-runtime"),
  "react-dom": require.resolve("react-dom"),
  "react-dom/client": require.resolve("react-dom/client"),
}

export default [
  pdfAssets(),
  {
    name: "blame-app:config",
    config() {
      return {
        envDir: root,
        resolve: {
          alias: [
            { find: /^react-dom\/client$/, replacement: reactRuntime["react-dom/client"] },
            { find: /^react-dom$/, replacement: reactRuntime["react-dom"] },
            { find: /^react\/jsx-dev-runtime$/, replacement: reactRuntime["react/jsx-dev-runtime"] },
            { find: /^react\/jsx-runtime$/, replacement: reactRuntime["react/jsx-runtime"] },
            { find: /^react$/, replacement: reactRuntime.react },
            { find: "@", replacement: path.resolve(root, "src") },
          ],
          dedupe: ["react", "react-dom"],
        },
        optimizeDeps: {
          include: Object.keys(reactRuntime),
          esbuildOptions: {
            jsx: "automatic",
            jsxImportSource: "react",
          },
        },
        esbuild: {
          jsx: "automatic",
          jsxImportSource: "react",
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "blame-app:theme-preload",
    transformIndexHtml(html) {
      return html
        .replace(
          '<script id="oc-theme-preload-script" src="./oc-theme-preload.js"></script>',
          `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
        )
        .replace(
          '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
          `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
        )
    },
  },
  react(),
  tailwindcss(),
]
