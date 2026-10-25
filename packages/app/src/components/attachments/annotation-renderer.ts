import {
  annotationBounds,
  arrowHead,
  textSize,
  type Annotation,
} from "./annotation-model"

export function drawAnnotations(
  context: CanvasRenderingContext2D,
  marks: Annotation[]
) {
  for (const mark of marks) {
    context.save()
    context.strokeStyle = mark.color
    context.fillStyle = mark.color
    context.lineWidth = mark.width
    context.lineCap = "round"
    context.lineJoin = "round"
    const first = mark.points[0]
    const bounds = annotationBounds(mark)
    context.beginPath()
    if (mark.kind === "text") {
      context.font = `600 ${textSize(mark)}px sans-serif`
      context.textBaseline = "top"
      ;(mark.text ?? "")
        .split("\n")
        .forEach((line, i) =>
          context.fillText(line, first.x, first.y + i * textSize(mark) * 1.25)
        )
    } else if (mark.kind === "rectangle") {
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
    } else if (mark.kind === "ellipse") {
      context.ellipse(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        bounds.width / 2,
        bounds.height / 2,
        0,
        0,
        Math.PI * 2
      )
      context.stroke()
    } else {
      context.moveTo(first.x, first.y)
      mark.points.slice(1).forEach((p) => context.lineTo(p.x, p.y))
      if (mark.points.length === 1) {
        context.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2)
        context.fill()
      }
      if (mark.kind === "arrow") {
        const end = mark.points.at(-1)!
        const [left, right] = arrowHead(mark)
        context.moveTo(left.x, left.y)
        context.lineTo(end.x, end.y)
        context.lineTo(right.x, right.y)
      }
      context.stroke()
    }
    context.restore()
  }
}

export function loadAnnotationImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Stored attachments use CORS-enabled download URLs. Failure is recoverable in the viewer.
    image.crossOrigin = "anonymous"
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(
        new Error(
          "This image could not be loaded. Close the viewer and try again."
        )
      )
    image.src = source
  })
}

export async function renderAnnotatedImage(
  source: string,
  marks: Annotation[]
): Promise<Blob> {
  const image = await loadAnnotationImage(source)
  // Avoid browser-specific silent canvas truncation and excessive allocations.
  if (
    image.naturalWidth * image.naturalHeight > 32_000_000 ||
    Math.max(image.naturalWidth, image.naturalHeight) > 16384
  ) {
    throw new Error(
      "This image is too large to annotate. Resize it to 32 megapixels or less, with each side under 16,384 pixels, and try again."
    )
  }
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Image editing is unavailable in this browser.")
  context.drawImage(image, 0, 0)
  context.scale(canvas.width / 1000, canvas.width / 1000)
  drawAnnotations(context, marks)
  try {
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error("The annotated image could not be saved. Try again.")
              ),
        "image/png"
      )
    )
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
