/** Filled from the signed preview image release, never with a tag. */
export const publishedPreviewImages: {
  display?: string;
  node?: string;
  tauri?: string;
} = {
  display:
    "ghcr.io/rchrp/blame-preview-display@sha256:ff979c4dd3b0df001f26252d2da11949f86c820ff7dde8fbbb94bc1d7bd98e2b",
  node: "ghcr.io/rchrp/blame-gui-node@sha256:6f872691f66907727f83cb8bf28ca511d8cb7b5d9ea7c5fae44f51c211774a93",
  tauri:
    "ghcr.io/rchrp/blame-gui-tauri@sha256:b11ed898837a768ae8e086bc591bfbcfce6b31e86fb9b235c777e1d3713cdd9e",
};

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
