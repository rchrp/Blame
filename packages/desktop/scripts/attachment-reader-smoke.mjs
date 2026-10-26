// Exercise the same utility-process host as the desktop agent, not plain Node.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.parentPort) {
  try {
    const { readAttachment } =
      await import("../../agent-runtime/dist/attachment-reader.js");
    const { storeWorkspaceAttachment } =
      await import("../../agent-runtime/dist/development-attachments.js");
    const root = await mkdtemp(join(tmpdir(), "blame-electron-attachment-"));
    try {
      const bytes = await readFile(
        new URL(
          "../../agent-runtime/src/fixtures/attachments/report.pdf",
          import.meta.url,
        ),
      );
      const path = await storeWorkspaceAttachment(root, {
        name: "report.pdf",
        contentBase64: bytes.toString("base64"),
      });
      for (const [page, expected] of [
        [1, /revenue is 42 EUR/],
        [2, /deadline is Friday/],
      ]) {
        const result = await readAttachment(root, { path, page });
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.match(result.data.text, expected);
        assert.equal(result.data.pages, 2);
      }
      assert.deepEqual(await readFile(path), bytes);
      for (const [name, expected] of [
        ["report.docx", /owner is Alice/],
        ["report.xlsx", /Travel\t42/],
      ]) {
        const content = await readFile(
          new URL(
            `../../agent-runtime/src/fixtures/attachments/${name}`,
            import.meta.url,
          ),
        );
        const file = await storeWorkspaceAttachment(root, {
          name,
          contentBase64: content.toString("base64"),
        });
        const result = await readAttachment(root, { path: file });
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.match(result.data.text, expected);
      }
      // Optional local reproduction; the source file is only read and no
      // document text is printed in logs or copied into repository fixtures.
      if (process.argv[2]) {
        const content = await readFile(process.argv[2]);
        const file = await storeWorkspaceAttachment(root, {
          name: "reproduction.pdf",
          contentBase64: content.toString("base64"),
        });
        const result = await readAttachment(root, { path: file });
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.ok(result.data.text.trim().length > 0);
        console.log(
          `Reproduction PDF: ${result.data.pages} pages; ${result.data.text.length} characters read on page 1`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    process.parentPort.postMessage({ ok: true, processType: process.type });
  } catch (error) {
    process.parentPort.postMessage({
      ok: false,
      error: error.stack,
      processType: process.type,
    });
  }
} else {
  const { app, utilityProcess } = await import("electron");
  void app.whenReady().then(() => {
    const child = utilityProcess.fork(
      fileURLToPath(import.meta.url),
      process.argv.slice(2),
      { stdio: "inherit", serviceName: "Blame attachment regression test" },
    );
    let finished = false;
    const timeout = setTimeout(
      () => finish(new Error("Attachment utility process timed out")),
      30_000,
    );
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.kill();
      if (error) console.error(error);
      else
        console.log(
          "PDF, Word and Excel reading passed in Electron utility process",
        );
      app.exit(error ? 1 : 0);
    }
    child.on("message", (result) =>
      finish(
        result.ok
          ? undefined
          : new Error(`${result.processType}: ${result.error}`),
      ),
    );
    child.on("exit", (code) => {
      if (!finished)
        finish(new Error(`Utility process exited early (${code})`));
    });
  });
}
