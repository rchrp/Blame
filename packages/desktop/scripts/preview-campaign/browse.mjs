// A throwaway browser for the campaign: loads a preview URL in a hidden
// Electron window and answers JSON lines on stdin, so the campaign can see what
// a person would see (rendered text, console errors, failed requests) and
// whether a source edit reaches an already open page (hot reload).
//
//   electron browse.mjs <url> <userDataDirectory>
//   stdin:  {"op":"text"} | {"op":"reload"} | {"op":"quit"}
//   stdout: one JSON line per answer, "BROWSE_READY {...}" after the first load
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const [url, userData] = process.argv.slice(-2).length === 2 && process.argv.at(-2).startsWith("http") ? process.argv.slice(-2) : [process.argv.at(-1), undefined];
const debug = (line) => process.env.BROWSE_DEBUG && console.error(`[browse] ${line}`);
debug(`start ${process.argv.slice(1).join(" ")}`);
const { app, BrowserWindow } = await import("electron");
debug(`electron imported: ${typeof app}`);
if (userData) app.setPath("userData", userData);
app.dock?.hide();
void app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function main() {
debug("ready");

const errors = [];
const failedRequests = [];
const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { backgroundThrottling: false, sandbox: true } });
window.webContents.on("console-message", (...args) => {
  const event = args[0]?.level !== undefined ? args[0] : { level: args[1], message: args[2] };
  const level = typeof event.level === "string" ? event.level : ["verbose", "info", "warning", "error"][event.level] ?? String(event.level);
  if (level === "error") errors.push(String(event.message).slice(0, 300));
});
window.webContents.on("did-fail-load", (_event, code, description, failedUrl) => failedRequests.push(`load ${code} ${description} ${failedUrl}`));
window.webContents.session.webRequest.onCompleted((details) => {
  if (details.statusCode >= 400) failedRequests.push(`${details.statusCode} ${details.method} ${details.url}`.slice(0, 300));
});
window.webContents.session.webRequest.onErrorOccurred((details) => {
  if (details.error !== "net::ERR_ABORTED") failedRequests.push(`${details.error} ${details.url}`.slice(0, 300));
});

const read = () =>
  window.webContents.executeJavaScript(`({ title: document.title, text: document.body ? document.body.innerText : "", html: document.documentElement.outerHTML.length, url: location.href })`);
const answer = async (extra = {}) => ({ ...(await read()), errors: [...errors], failedRequests: [...failedRequests], ...extra });

const begun = Date.now();
debug("loading");
await window.loadURL(url).catch((error) => failedRequests.push(`loadURL ${error.message}`));
// Frameworks keep working after load: wait for the network to settle.
await new Promise((done) => setTimeout(done, 2500));
console.log(`BROWSE_READY ${JSON.stringify(await answer({ loadMs: Date.now() - begun }))}`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.op === "quit") break;
  if (message.op === "reload") {
    await window.loadURL(url).catch((error) => failedRequests.push(`loadURL ${error.message}`));
    await new Promise((done) => setTimeout(done, 1500));
  }
  console.log(`BROWSE_ANSWER ${JSON.stringify(await answer())}`);
}
app.exit(0);
}
void fileURLToPath;
