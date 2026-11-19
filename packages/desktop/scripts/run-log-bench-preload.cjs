// The run log bench page's bridge to the run log store (run-log-bench.mjs),
// as the app's preload exposes it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("benchRunLogs", {
  append: (id, lines) => ipcRenderer.send("run-log:append", id, lines),
  read: (id, from, to) => ipcRenderer.invoke("run-log:read", id, from, to),
  copy: (id, before, after, endsSelection) =>
    ipcRenderer.invoke("run-log:copy", id, before, after, endsSelection),
  close: (id) => ipcRenderer.send("run-log:close", id),
});
