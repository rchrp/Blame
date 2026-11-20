# Attachments in the agent runtime

Blame preserves the original file bytes in `.blame/attachments` in the agent's
workspace. Document paths and `read_attachment` instructions are included in the
prompt. The tool reads PDF pages, DOCX text, XLSX sheets and UTF-8 text on demand;
it does not run MarkItDown or create converted copies. Image attachments reach
the model as image blocks of the message.

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
workspace confinement. `scripts/semantic-harness-payload.test.mjs`
checks PDF reading from the independently packaged remote harness.
