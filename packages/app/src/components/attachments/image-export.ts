import type { Annotation } from "./annotation-model"
import { renderAnnotatedImage } from "./annotation-renderer"

// The image as a file: flattened with its marks when it has any.
export async function imageBlob(
  source: string,
  marks: Annotation[]
): Promise<Blob> {
  if (marks.length) return renderAnnotatedImage(source, marks)
  const response = await fetch(source)
  if (!response.ok) throw new Error("The image could not be read.")
  return response.blob()
}

async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("The image could not be copied.")),
        "image/png"
      )
    )
  } finally {
    bitmap.close()
  }
}

export async function copyImageToClipboard(blob: Blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("Copying images is not available here. Save it instead.")
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob(blob) }),
  ])
}

export function downloadImage(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
