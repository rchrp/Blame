import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the directory containing the three released .image files.')
const pins = {}
for (const kind of ['display', 'node', 'tauri']) {
  const image = (await readFile(join(directory, `${kind}.image`), 'utf8')).trim()
  if (!/^ghcr\.io\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Invalid immutable ${kind} image.`)
  pins[kind] = image
}
await writeFile('packages/preview-runtime/src/compose/blame-images.ts', `// Generated from published, signed preview images.\nexport const publishedPreviewImages = ${JSON.stringify(pins, null, 2)};\n\nexport function previewDisplayImage(override?: string) {\n  const image = override ?? publishedPreviewImages.display;\n  if (!/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Screen previews need a published image pinned by digest.");\n  return image;\n}\n`)
