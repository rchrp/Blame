# Image attachments and annotations

The shared Markdown composer opens image thumbnails in a gallery. Editable composers can annotate and apply changes; read-only consumers omit `onSave`. This extends the existing app UI: Radix dialog, shared buttons/popovers/tooltips, semantic app colors, Lucide icons, and a compact toolbar that wraps on narrow screens. There are no generated visual assets or additional design-system tokens.

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
