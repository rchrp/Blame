/** Filled by the image release workflow after publication, never with a tag. */
export const publishedPreviewImages: {
  display?: string;
  node?: string;
  tauri?: string;
} = {};

export function previewDisplayImage(override?: string) {
  const image =
    override ??
    publishedPreviewImages.display ??
    (typeof process !== "undefined"
      ? process.env.BLAME_PREVIEW_DISPLAY_IMAGE
      : undefined);
  if (!image || !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error(
      "Screen previews need the published display image. Install the updated preview runtime and try again.",
    );
  return image;
}
