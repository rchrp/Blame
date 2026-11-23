// Drives the "Bring your setup" step in the built app (out/), in its own
// profile and with a fake home for the other tools' files, the way a person
// meets it on a first run:
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   node scripts/agent-import-drive.mjs [--shots <folder>]
//
// `BLAME_AGENT_IMPORT_HOME` points the scan (and the skills copy) at the fake
// home; HOME itself is never changed (the app's keychain item lives there).
// The drive checks that no fake secret reaches the page, imports the default
// selection, then looks at the files the import wrote.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const resultPrefix = "AGENT_IMPORT_DRIVE ";
const secrets = [
  "sk-fake-dokploy-0001",
  "ghp_fakeGithubToken0002",
  "fake-bearer-0003",
];

if (process.versions.electron) await runInElectron();
else await runDrive();

async function runDrive() {
  const shots = resolve(argument("--shots") ?? "agent-import-shots");
  const scratch = await mkdtemp(join(tmpdir(), "blame-agent-import-drive-"));
  try {
    await mkdir(shots, { recursive: true });
    const home = join(scratch, "home");
    await fakeHome(home);
    const electron = createRequire(import.meta.url)("electron");
    const environment = { ...process.env, BLAME_AGENT_IMPORT_HOME: home };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.BLAME_RUNTIME_BIN_DIR;
    const child = spawn(
      electron,
      [fileURLToPath(import.meta.url), join(scratch, "profile"), shots, home],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 150_000);
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => (output = (output + data).slice(-100_000)));
    const code = await new Promise((done) => child.once("close", done));
    clearTimeout(timeout);
    const line = output
      .split("\n")
      .find((entry) => entry.startsWith(resultPrefix));
    if (code !== 0 || !line)
      throw new Error(`Drive failed (${code}):\n${output.slice(-4000)}`);
    console.log(
      JSON.stringify(JSON.parse(line.slice(resultPrefix.length)), null, 2),
    );
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function fakeHome(home) {
  const files = {
    "Library/Application Support/Claude/claude_desktop_config.json":
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: [
              "-y",
              "@modelcontextprotocol/server-filesystem",
              "/Users/me/Documents",
            ],
          },
          github: {
            command: "docker",
            args: ["run", "-i", "ghcr.io/github/github-mcp-server"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: secrets[1] },
          },
        },
      }),
    ".claude.json": JSON.stringify({
      mcpServers: {
        dokploy: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dokploy/mcp"],
          env: { DOKPLOY_API_KEY: secrets[0] },
        },
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      },
      projects: {
        "/Users/me/app": {
          mcpServers: {
            postgres: {
              command: "npx",
              args: ["-y", "pg-mcp", "--url=postgres://u:p@localhost/db"],
            },
          },
        },
      },
    }),
    ".claude/CLAUDE.md": "Always answer in French.\n",
    ".claude/commands/review.md":
      "---\ndescription: Review the diff\n---\nReview it.\n",
    ".claude/skills/synced/org_user/pdf/SKILL.md":
      "---\nname: pdf\ndescription: Work with PDFs\n---\nUse pdftotext.\n",
    ".codex/config.toml": `[mcp_servers.home_assistant]\nurl = "https://ha.example.com/api/mcp"\nbearer_token_env_var = "HA_TOKEN"\n\n[mcp_servers.remote]\nurl = "https://remote.example.com/mcp"\nhttp_headers = { Authorization = "Bearer ${secrets[2]}" }\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"\n`,
    ".codex/skills/release-notes/SKILL.md":
      "---\nname: release-notes\ndescription: Write release notes\n---\nBody\n",
    ".cursor/mcp.json": JSON.stringify({
      mcpServers: { figma: { url: "http://127.0.0.1:3845/sse" } },
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), content);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function runInElectron() {
  const [profile, shots, home] = process.argv.slice(-3);
  const application = resolve(import.meta.dirname, "..");
  const { app, BrowserWindow, dialog } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"])
    app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameAgentImportDrive";
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  setTimeout(() => fail(new Error("Drive timed out")), 140_000);
  void app.whenReady().then(drive).catch(fail);

  async function drive() {
    const report = {};
    let window = await showing("");
    // A first run without an account: local workspace, a provider chosen.
    await window.webContents.executeJavaScript(`(async () => {
      const session = await window.blame.localApi.session();
      const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", credentialLabel: null, reasoningEffort: null };
      const response = await fetch(session.url.replace(/\\/$/, "") + "/account/ai-preferences", {
        method: "PUT",
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        body: JSON.stringify({ agentModel: model, alternativeModel: model }),
      });
      if (!response.ok) throw new Error("AI preferences: " + response.status);
      localStorage.setItem("blame.app.workspace-start.v1", "local");
      localStorage.setItem("blame.runtime-offer-done.v1", "true");
    })()`);
    window.webContents.reload();
    window = await showing("Bring your setup");
    await delay(1500);
    const html = await window.webContents.executeJavaScript(
      "document.body.innerHTML",
    );
    report.secretsInPage = secrets.filter((secret) => html.includes(secret));
    report.progress = await window.webContents.executeJavaScript(
      `[...document.querySelectorAll('[aria-label="Setup progress"] li')].map((li) => li.innerText.trim())`,
    );
    // First screen: every tool, in colour when found, grey when not.
    report.tiles = await window.webContents.executeJavaScript(
      `[...document.querySelectorAll("li > button")].map((b) => b.innerText.replace(/\\n+/g, " | ") + (b.disabled ? " [disabled]" : b.getAttribute("aria-pressed") === "true" ? " [picked]" : ""))`,
    );
    await shot(window, join(shots, "1-sources.png"));
    await click(window, "Next");
    await delay(800);
    report.reviewText = await window.webContents.executeJavaScript(
      `document.body.innerText.slice(0, 2500)`,
    );
    await shot(window, join(shots, "1b-review.png"));

    await click(window, "Import ");
    await delay(1500);
    report.resultText = await window.webContents.executeJavaScript(
      `document.body.innerText.slice(0, 1200)`,
    );
    await shot(window, join(shots, "2-result.png"));

    const settings = JSON.parse(
      await readFile(
        join(profile, "dev.blame.desktop.development", "mcp-settings.json"),
        "utf8",
      ).catch(() => '{"mcpServers":{}}'),
    );
    report.importedServers = Object.fromEntries(
      Object.entries(settings.mcpServers).map(([name, value]) => [
        name,
        { type: value.type, disabled: value.disabled },
      ]),
    );
    report.keptTheSecret =
      settings.mcpServers.dokploy?.env?.DOKPLOY_API_KEY === secrets[0];
    report.skillFolders = await readdir(join(home, ".agents", "skills")).catch(
      () => [],
    );

    // The renderer's second look: everything is already there.
    report.rescan = await window.webContents.executeJavaScript(
      `window.blame.agentImport.scan().then((scan) => scan.sources.flatMap((s) => s.items.filter((i) => i.state === "new" || i.state === "conflict").map((i) => i.id)))`,
    );
    await click(window, "Continue");
    await delay(1200);
    report.afterContinue = await window.webContents.executeJavaScript(
      `document.body.innerText.slice(0, 200)`,
    );

    // Later, from Settings → MCP: a project is open, and the same review
    // only offers what Blame does not have yet.
    const project = join(profile, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "package.json"),
      '{"name":"drive-project"}\n',
    );
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: project });
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
    await click(window, "Open Project");
    window = await showing("Agent Queue");
    await window.webContents.executeJavaScript(
      `history.pushState({}, "", "/settings"); dispatchEvent(new PopStateEvent("popstate"))`,
    );
    await showing("Server connections").catch(async () => {
      await click(window, "MCP");
      await showing("Server connections");
    });
    await click(window, "Import from other tools");
    await delay(1500);
    await click(window, "Next");
    await delay(800);
    report.settingsText = await window.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText.slice(0, 900)`,
    );
    await shot(window, join(shots, "3-settings.png"));
    console.log(`${resultPrefix}${JSON.stringify(report)}`);
    app.exit(0);
  }

  async function click(window, startsWith) {
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(${JSON.stringify(startsWith)}));
      button?.click();
      return Boolean(button);
    })()`);
    if (!clicked) throw new Error(`No button starting with "${startsWith}"`);
  }

  async function shot(window, path) {
    await writeFile(path, (await window.webContents.capturePage()).toPNG());
  }

  async function showing(text, timeoutMs = 60_000) {
    const check = `document.readyState === "complete" && Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isLoading()) continue;
        if (
          await window.webContents.executeJavaScript(check).catch(() => false)
        )
          return window;
      }
      await delay(100);
    }
    const screens = await Promise.all(
      BrowserWindow.getAllWindows().map((window) =>
        window.webContents
          .executeJavaScript("document.body?.innerText.slice(0, 600)")
          .catch(String),
      ),
    );
    throw new Error(
      `Timed out waiting for "${text}", on:\n${screens.join("\n---\n")}`,
    );
  }

  await import(pathToFileURL(join(application, "out/main/index.js")).href);
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
