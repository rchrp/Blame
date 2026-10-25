import { createRequire } from "node:module"
import { dirname, join, basename } from "node:path"
import { readFile, readdir } from "node:fs/promises"

const require = createRequire(import.meta.url)
const root = dirname(require.resolve("pdfjs-dist/package.json"))
const directories = ["cmaps", "standard_fonts", "wasm"]

// PDF.js requests these resources by their original names. Bundle them locally
// for offline Electron use; no public CDN or remote document service is involved.
export default function pdfAssets() {
  return {
    name: "blame-app:pdf-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const match = request.url
          ?.split("?")[0]
          .match(/\/pdfjs\/(cmaps|standard_fonts|wasm)\/([^/]+)$/)
        if (!match) return next()
        if (basename(match[2]) !== match[2] || match[2].includes(".."))
          return next()
        try {
          const content = await readFile(join(root, match[1], match[2]))
          response.setHeader(
            "Content-Type",
            match[2].endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream"
          )
          response.end(content)
        } catch {
          next()
        }
      })
    },
    async generateBundle() {
      for (const directory of directories) {
        for (const name of await readdir(join(root, directory))) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${directory}/${name}`,
            source: await readFile(join(root, directory, name)),
          })
        }
      }
    },
  }
}
