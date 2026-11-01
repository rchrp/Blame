// Explains a workspace too large for a cloud preview: how much it sends,
// the limit, and the largest paths, so the user knows what to put in
// .blameignore.

// Media, PDFs and archives barely compress, and each file travels twice in
// the archive (as a file and in the Git snapshot). When they alone already
// exceed the limit, the archive will too: say so before a sandbox starts.
const incompressible =
  /\.(?:pdf|png|jpe?g|gif|webp|avif|heic|tiff?|psd|ai|sketch|fig|mp[34]|m4[av]|mov|webm|mkv|avi|wav|flac|ogg|aac|zip|gz|tgz|bz2|xz|7z|rar|zst|jar|apk|ipa|dmg|iso|woff2?)$/i;

export function assertWorkspaceFitsTransfer(
  files: Record<string, { size: number }>,
  limitBytes: number,
) {
  let bytes = 0;
  for (const [path, { size }] of Object.entries(files))
    if (incompressible.test(path)) bytes += size;
  if (bytes * 2 > limitBytes)
    throw new Error(
      workspaceTooLargeMessage(bytes * 2, limitBytes, files, true),
    );
}

export function workspaceTooLargeMessage(
  compressedBytes: number,
  limitBytes: number,
  files: Record<string, { size: number }>,
  estimate = false,
) {
  const sizes = new Map<string, number>();
  for (const [path, { size }] of Object.entries(files)) {
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const key = parts.slice(0, depth).join("/");
      sizes.set(key, (sizes.get(key) ?? 0) + size);
    }
  }
  // A path inside one already listed says the same thing.
  const largest: Array<[string, number]> = [];
  for (const entry of [...sizes].sort((left, right) => right[1] - left[1])) {
    if (largest.length >= 3) break;
    if (largest.some(([taken]) => entry[0].startsWith(`${taken}/`))) continue;
    largest.push(entry);
  }
  const examples = largest
    .map(([path, size]) => {
      const directory = Object.keys(files).some((file) =>
        file.startsWith(`${path}/`),
      );
      return `/${path}${directory ? "/**" : ""} (${megabytes(size)})`;
    })
    .join(", ");
  return `This project sends ${estimate ? "at least " : ""}${megabytes(compressedBytes)} to the cloud once compressed, over the ${megabytes(limitBytes)} limit. List the large files its preview does not need in .blameignore, for example ${examples}.`;
}

function megabytes(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}
