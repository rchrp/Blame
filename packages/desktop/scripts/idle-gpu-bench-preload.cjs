// The idle GPU bench page's bridge to its native preview (idle-gpu-bench.mjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("benchPreview", {
  capture: () => ipcRenderer.invoke("bench:capture"),
  setBounds: (bounds) => ipcRenderer.send("bench:bounds", bounds),
});
