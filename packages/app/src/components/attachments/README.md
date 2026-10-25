# Attachment previews and image annotations

## File cards and document viewer

`attachment-preview.tsx` provides the shared composer/read-only card: images are
160×160 without a visible title; file cards are 224×160 in total, including a
40px filename strip with a colored Lucide format icon. The attachment row scrolls
horizontally. A native button opens each card, and removal remains a separate
button available to keyboard and touch users.

`document-attachment-gallery.tsx` is the read-only document dialog. It uses the
same translucent blurred backdrop as the image gallery, with no visible header,
floating controls, Escape to close, focus restoration, and arrow-key/file-button
navigation. PDF page controls are separate from file navigation (Page Up/Down
within the PDF).

Cards and viewer controls retain the app's semantic colors, shared Radix dialog
and buttons, and existing rounded shapes. Documents use a white reading surface
in both app themes. `document-preview.css` scopes readable text, table borders,
and blue links to that surface; its serif document typography does not change
the app's Source Sans 3 body and Nunito Sans heading fonts. At narrow widths,
file-navigation controls move below the viewer; the cards keep their dimensions
inside the horizontally scrolling attachment row.

| Format | Preview |
| --- | --- |
| PDF | First-page thumbnail; paginated canvas reader, fit-page zoom and screen-reader text |
| DOCX | Sanitized semantic HTML with embedded raster images and tables; original pagination/styles are not reproduced |
| XLSX | Sheet selection and cached cell values; 100 rows per displayed page; formulas are not recalculated |
| CSV / TSV | Table, including quoted delimiters and multiline cells |
| Markdown | Existing Markdown renderer |
| LaTeX / text / source files | Readable source; no TeX compilation or code execution |
| Legacy DOC / XLS / PPT and other formats | Existing extracted Markdown when available; otherwise open/download original |
| Audio / video | OS default application on desktop; download on the web |

Libraries are [PDF.js](https://github.com/mozilla/pdf.js),
[Mammoth](https://github.com/mwilliamson/mammoth.js),
[read-excel-file](https://github.com/catamphetamine/read-excel-file), and
[Papa Parse](https://github.com/mholt/PapaParse). They load dynamically; there is no
remote conversion/viewer service. `vite-pdf-assets.js` bundles PDF fonts, CMaps,
and WASM resources locally for both the web build and offline Electron use.

### Resource and content boundaries

- IntersectionObserver starts previews only near the visible attachment strip.
  A weak-key cache shares results between cards and the dialog and releases them
  with their File objects. At most two preview jobs run simultaneously.
- Office/text parsing happens in disposable workers terminated after 15 seconds.
  Preview inputs are bounded to 25 MiB (10 MiB for Office); remote streams are
  checked against the limit even when stored size metadata is incorrect.
- Text previews stop at 200,000 characters. Tables stop at 20 sheets, 1,000 rows,
  50 columns and 2,000 characters per cell. Truncation is visible in the reader;
  the original attachment is preserved. Word thumbnails use a bounded DOM excerpt.
- PDF thumbnails destroy their document/worker after rendering. The reader keeps
  one page canvas, cancels superseded renders, and destroys its PDF when closed.
  PDF actions, links, scripts and embedded attachments are not executed.
- Mammoth HTML is allowlisted through DOMPurify. Styles, handlers, links, frames
  and remote images are removed; supported embedded raster images remain.
- Persisted attachment File objects can be empty placeholders. `attachment-file.ts`
  reads the stored download URL, never treating the placeholder as the original.
- Desktop `shell:open-attachment` accepts only app windows, typed bytes up to
  100 MiB, and document/media extensions. It writes a sanitized filename to a
  private temporary directory, calls `shell.openPath`, and cleans up on app exit.
  Executable/script extensions are refused. Unsupported formats can be downloaded.

Validation: `pnpm --filter @blame/app test:attachments` includes format detection,
restored file fetching and size bounds. Desktop `attachment-open-input.test.ts`
covers IPC payload validation, path sanitization and executable rejection.
Browser checks should cover PDF pagination/zoom, worksheet selection, malformed
files/retry, keyboard focus restoration, large inputs, and both viewport sizes.

## Image annotation implementation

The shared Markdown composer opens image thumbnails in a gallery. Editable composers can annotate and apply changes; read-only consumers omit `onSave`. This extends the existing app UI: Radix dialog, shared buttons/popovers/tooltips, semantic app colors, and Lucide icons. The gallery fills the viewport over a translucent blurred backdrop, without a visible header, filename, or footer divider. Annotation tools float at the bottom, with Save and Close in a detached action group to their right; tools wrap on narrow screens. The dialog title and editing hints remain available to assistive technology. There are no generated visual assets or additional design-system tokens.

## Ownership

- `image-attachment-gallery.tsx` owns browsing, per-image undo/redo histories, selection, text entry, unsaved-change confirmation, and exporting all changed images before calling `onSave` once.
- `annotation-canvas.tsx` owns image loading/retry, fitted display size, pointer gestures, selection outlines, and temporary gesture previews. Pointer cancellation discards the unfinished gesture.
- `annotation-toolbar.tsx` owns tool, color, and width controls. Style changes also update the selected mark.
- `annotation-model.ts` owns geometry, hit testing, movement bounds, filenames, and immutable history (up to 100 undo snapshots per image).
- `annotation-renderer.ts` shares mark rendering between preview and PNG export and measures/wraps text with the export font.
- `../backlog/drawer/markdown-editor.tsx` owns attachment replacement, original/preview URL lifetime, and focus restoration. Its parent owns persisted attachment lists via `onFileAttachmentsReplace`; `user-story-attachment-files.ts` provides the replacement helper.

## Coordinates and rendering

Store points and stroke widths in a canonical image space: width `1000`, height `1000 * naturalHeight / naturalWidth`. Text bounds use that space too; the stored `textWidth` is measured in em so it follows text-size changes. Convert pointer positions using the displayed canvas bounds; never persist viewport pixels or device pixel ratios. The preview fits the image without upscaling and caps overlay resolution at 2× CSS size. Export renders at the original image dimensions and scales both axes by `naturalWidth / 1000`.

Select/erase hit visible strokes, with the topmost matching annotation winning. Movement keeps annotation geometry inside the image. Text uses measured widths, wraps to fit, and is rejected if its height exceeds the image. The eraser removes whole marks; it does not erase source-image pixels.

## Persistence contract

`ImageAnnotation` contains the original `source` plus editable `marks`. These remain in memory only during the same mounted composer, including reopening its gallery after applying. Gallery undo/redo history lasts only for that gallery session. Closing the gallery with unapplied changes offers discard confirmation; navigating between images retains those changes.

Applying produces a flattened `image/png` file named `*-annotated.png`, without stacking the suffix. The flattened PNG is the durable attachment stored in drafts and uploaded through the existing file pipeline. Original sources, editable marks, and undo history are not serialized. After a composer remount or draft restore, previous marks are baked into the image; new marks can be added, but previous marks cannot be individually selected or removed.

Every applied image receives a new attachment/upload ID because stored attachments are immutable. Replacement maps the old ID to the new attachment while preserving list order. Do not reuse the old upload identity or append the edited file beside it. The composer first awaits pending attachment conversions for the affected IDs (including a shared image/document optimization batch), then converts every replacement, then publishes one replacement batch and updates local previews. Export/conversion failure leaves the existing attachments and editable marks available for retry; a late original conversion cannot append the original after a successful replacement.

The original object URL is retained for further editing while the composer is mounted. Superseded flattened preview URLs are revoked; removal/unmount also releases retained original URLs. A persistent composer must provide `onFileAttachmentsReplace` alongside `onFileAttachmentsAdd` to enable annotation editing.

## Keyboard controls

| Key                                            | Action                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Left / Right                                   | Previous / next image                                                         |
| V / P / A / R / O / T / E                      | Select / pen / arrow / rectangle / ellipse / text / erase                     |
| Cmd/Ctrl+Z                                     | Undo                                                                          |
| Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y                 | Redo                                                                          |
| Delete / Backspace                             | Delete selected annotation                                                    |
| Cmd/Ctrl+S                                     | Apply changed images                                                          |
| Enter on the focused canvas with Text selected | Open text entry                                                               |
| Cmd/Ctrl+Enter in text entry                   | Add or update text                                                            |
| Escape                                         | Cancel text entry, return from discard confirmation, or request gallery close |

Shortcuts stay inside the dialog and do not trigger the composer behind it. Tool/history shortcuts are inactive while typing, interacting with a popover, saving, or confirming discard. Tab follows the dialog controls; closing restores focus to the thumbnail, including its replacement ID, or falls back to the composer. Drawing, selection, and moving marks use pointer input; text entry also has the keyboard path above.

## Verification

Run `pnpm --filter @blame/app test:attachments` for geometry/history, replacement identity, and attachment upload regression coverage. Browser behavior and visual layout still require manual verification:

1. Attach two images, open a thumbnail, and browse with buttons and arrow keys. Check read-only viewing, loading/error retry, Escape, and focus return.
2. Add each mark type, edit text by double-clicking with Select, change the selected mark's color/width, move, erase, delete, undo, and redo. Resize the window and verify alignment remains on the image. Check portrait images and long text near image edges.
3. Edit both images, navigate back, then test Keep editing and Discard changes. Apply both and reopen them in the same composer to verify retained editable marks.
4. Restore the saved draft in a fresh composer and submit/upload it. Verify the flattened PNG pixels and new attachment ID, then confirm the restored image supports new annotations. Repeat with an image added alongside a document whose optimization is still pending; there must be one edited image and no late original duplicate.
5. Check desktop and 390px widths, keyboard focus, tooltip labels, color/width popovers, and the wrapping toolbar. Desktop and 390px layouts were visually reviewed during implementation; screenshot review does not establish upload or assistive-technology coverage.

Export is limited to 32 megapixels and a maximum side of 16,384 pixels. Remote images need a CORS-enabled source for canvas export; loading times out after 15 seconds. PNG export flattens animated input to a still image. Load/export failures display recoverable errors in the gallery and need browser-level checks beyond the model tests.
