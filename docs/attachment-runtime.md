# Attachments in the agent runtime

Blame preserves the original file bytes in `.blame/attachments` in the agent's
workspace. Document paths and `read_attachment` instructions are included in the
prompt. The tool reads PDF pages, DOCX text, XLSX sheets and UTF-8 text on demand;
it does not run MarkItDown or create converted copies. Image attachments use
the SDK's `userImages` data URLs for model vision.

## Cline SDK contract

The [Cline file workflow](https://docs.cline.bot/core-workflows/working-with-files)
describes PDF and spreadsheet support in the application. The
[ClineCore reference](https://docs.cline.bot/sdk/reference/cline-core) describes
the session API; the exact attachment behavior is verified against the source
for the installed SDK **0.0.95** (commit `c718573538d76310f464541617ab665108a6c999`):

- [Input assembly](https://github.com/cline/cline/blob/c718573538d76310f464541617ab665108a6c999/sdk/packages/core/src/runtime/orchestration/user-input-builder.ts)
  accepts `userImages` as base64/data URLs and `userFiles` as file paths.
- The [default file loader](https://github.com/cline/cline/blob/c718573538d76310f464541617ab665108a6c999/sdk/packages/core/src/runtime/host/local/user-files.ts)
  reads paths as UTF-8 and rejects content containing a null byte. It does not
  decode PDF, DOCX or XLSX. Sending these binary documents as `userFiles` does
  not provide their decoded contents to the model.

## Electron regression coverage

PDF.js 6.4.299 treats Electron utility processes as browser environments, even
though they have no DOM. Calling its reader there caused `document is not
defined`. PDF parsing now runs in a Node worker thread with cancellation and a
20-second deadline. The remote harness payload explicitly includes that worker.

Run `pnpm --filter @blame/desktop test:attachment-reader` to exercise PDF, DOCX
and XLSX reading in the same Electron utility-process host as the desktop agent.
After building the runtime, an optional local PDF can be checked with
`pnpm --filter @blame/desktop exec electron scripts/attachment-reader-smoke.mjs /absolute/path/document.pdf`.
This copies the input into a temporary workspace and prints only page/character
counts; it leaves the source unchanged.

The runtime's `attachment-reader.test.ts` also covers cancellation, bounds and
workspace confinement. `cline-sdk-smoke.test.ts` checks the document tool result
in a real SDK request to a local model stub. `scripts/semantic-harness-payload.test.mjs`
checks PDF reading from the independently packaged remote harness.
