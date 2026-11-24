import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServerConfig } from "@blame/app";
import {
  claudeCodePaths,
  claudeDesktopFolders,
  codexFolder,
  scanEnvironment,
  vscodeMcpFile,
} from "./environment.ts";
import {
  applyAgentImport,
  scanAgentSetups,
  type BlameMcpStore,
} from "./import.ts";
import { fingerprint, parseCodexConfig, parseJsonc } from "./servers.ts";

// Fake secrets: they must never come out of a scan.
const secrets = [
  "sk-fake-dokploy-0001",
  "ghp_fakeGithubToken0002",
  "fake-bearer-0003",
  "fake-query-key-0004",
];

async function fakeMacHome() {
  const home = await mkdtemp(join(tmpdir(), "blame-import-"));
  const files: Record<string, string> = {
    "Library/Application Support/Claude/claude_desktop_config.json":
      JSON.stringify({
        preferences: { sidebarMode: "chat" },
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
      numStartups: 3,
      mcpServers: {
        dokploy: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dokploy/mcp"],
          env: {
            DOKPLOY_API_KEY: secrets[0],
            DOKPLOY_URL: "https://dokploy.example.com",
          },
        },
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        events: {
          type: "sse",
          url: `https://events.example.com/sse?key=${secrets[3]}`,
        },
        broken: { type: "stdio" },
      },
      projects: {
        "/Users/me/app": {
          mcpServers: {
            postgres: {
              command: "npx",
              args: [
                "-y",
                "@modelcontextprotocol/server-postgres",
                "--url=postgres://u:p@localhost/db",
              ],
            },
          },
        },
        "/Users/me/other": {
          mcpServers: {
            postgres: {
              command: "npx",
              args: [
                "-y",
                "@modelcontextprotocol/server-postgres",
                "--url=postgres://u:p@localhost/db",
              ],
            },
          },
        },
      },
    }),
    ".claude/CLAUDE.md": "Always answer in French.\n",
    ".claude/commands/review.md":
      "---\ndescription: Review the diff\n---\nReview it.\n",
    ".claude/skills/local-skill/SKILL.md":
      "---\nname: local-skill\ndescription: Lives in ~/.claude/skills\n---\nBody\n",
    ".claude/skills/synced/org_user/pdf/SKILL.md":
      "---\nname: pdf\ndescription: Work with PDFs\n---\nUse pdftotext.\n",
    ".claude/skills/synced/org_user/pdf/scripts/run.py": "print('hi')\n",
    ".claude/agents/reviewer.md": "---\nname: reviewer\n---\n",
    ".claude/plugins/installed_plugins.json": JSON.stringify({
      version: 2,
      plugins: { "impeccable@impeccable": [{}] },
    }),
    ".claude/settings.json": JSON.stringify({
      hooks: { PreToolUse: [] },
      theme: "dark",
    }),
    ".codex/config.toml": `model = "gpt-5"

[mcp_servers.dokploy]
command = "npx"
args = ["-y", "@dokploy/mcp"]

[mcp_servers.dokploy.env]
DOKPLOY_API_KEY = "${secrets[0]}"
DOKPLOY_URL = "https://dokploy.example.com"

[mcp_servers.dokploy.tools.domain-validateDomain]
approval_mode = "approve"

[mcp_servers.home_assistant]
url = "https://ha.example.com/api/mcp"
bearer_token_env_var = "HA_TOKEN"

[mcp_servers.remote]
url = "https://remote.example.com/mcp"
http_headers = { Authorization = "Bearer ${secrets[2]}" }
enabled = false

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"

[mcp_servers.computer-use]
command = "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
args = ["mcp"]
`,
    ".codex/AGENTS.md": "Be terse.\n",
    ".codex/skills/.system/imagegen/SKILL.md": "---\nname: imagegen\n---\n",
    ".codex/skills/release-notes/SKILL.md":
      "---\nname: release-notes\ndescription: Write release notes\n---\nBody\n",
    ".cline/data/settings/cline_mcp_settings.json": JSON.stringify({
      mcpServers: {
        Stripe: {
          disabled: true,
          type: "streamableHttp",
          url: "https://mcp.stripe.com",
        },
        "cline-fs": { command: "npx", args: ["-y", "fs-mcp"], type: "stdio" },
      },
    }),
    ".cursor/mcp.json": JSON.stringify({
      mcpServers: { figma: { url: "http://127.0.0.1:3845/sse" } },
    }),
    "Library/Application Support/Code/User/mcp.json": `// VS Code
{
  "inputs": [{ "id": "token", "type": "promptString" }],
  "servers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp", "headers": { "Authorization": "Bearer \${input:token}" } },
  },
}
`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), content);
  }
  return scanEnvironment(home, { BLAME_AGENT_IMPORT_HOME: home }, "darwin");
}

function memoryStore(initial: McpServerConfig[] = []) {
  const servers = [...initial];
  const store: BlameMcpStore = {
    list: async () =>
      servers.map((server) => ({
        name: server.name,
        fingerprint: fingerprint(server),
      })),
    add: async (input) => {
      const added: string[] = [];
      for (const server of input) {
        if (
          servers.some(
            (existing) =>
              existing.name.toLowerCase() === server.name.toLowerCase(),
          )
        )
          continue;
        servers.push(server);
        added.push(server.name);
      }
      return added;
    },
  };
  return { servers, store };
}

const blameServer = (
  name: string,
  command: string,
  args: string[],
): McpServerConfig => ({
  name,
  command,
  args,
  transport: "stdio",
  disabled: false,
  requiresLocalSetup: false,
  oauth: { configured: false, supported: false },
});

test("a scan lists every source, category and item, and hides every secret", async () => {
  const environment = await fakeMacHome();
  try {
    const { store } = memoryStore();
    const scan = await scanAgentSetups(environment, store);
    const json = JSON.stringify(scan);
    for (const secret of secrets)
      assert.equal(json.includes(secret), false, secret);
    assert.equal(json.includes("u:p@"), false);
    assert.deepEqual(
      scan.sources.map((source) => source.id),
      [
        "claude-desktop",
        "claude-code",
        "codex",
        "cursor",
        "vscode",
        "cline",
        "opencode",
        "kilo",
        "roo",
        "antigravity",
        "gemini",
        "qwen",
        "goose",
        "continue",
        "zed",
      ],
    );

    const byId = (id: string) =>
      scan.sources.find((source) => source.id === id)!;
    assert.deepEqual(
      byId("claude-desktop").items.map((item) => item.name),
      ["filesystem", "github"],
    );
    assert.deepEqual(byId("claude-desktop").items[1]!.secrets, [
      "GITHUB_PERSONAL_ACCESS_TOKEN",
    ]);

    const code = byId("claude-code");
    const servers = code.items.filter((item) => item.category === "mcp");
    // dokploy, linear and postgres once (the same project server twice is one);
    // the SSE server with its key in the address is left out.
    assert.deepEqual(
      servers.map((item) => item.name),
      ["dokploy", "linear", "postgres"],
    );
    assert.equal(servers[2]!.defaultSelected, false);
    assert.equal(servers[2]!.scope, "/Users/me/app");
    assert.match(servers[2]!.summary, /--url=postgres:\/\/••••@localhost\/db$/);
    assert.equal(servers[0]!.defaultSelected, true);
    const inPlace = code.items
      .filter((item) => item.state === "in-place")
      .map((item) => `${item.category}:${item.name}`);
    assert.deepEqual(inPlace, ["skill:local-skill", "command:review"]);
    assert.deepEqual(
      code.items
        .filter((item) => item.category === "skill" && item.state === "new")
        .map((item) => item.name),
      ["pdf"],
    );
    assert.deepEqual(
      code.unsupported.map((entry) => entry.label),
      [
        "Global instructions (CLAUDE.md)",
        "Subagents",
        "Plugins",
        "Hooks",
        "Servers with a token in their address",
      ],
    );

    const codex = byId("codex");
    // Dokploy is Claude Code's already (same command and arguments): offered once.
    assert.deepEqual(
      codex.items.map((item) => `${item.name}:${item.state}`),
      ["home_assistant:new", "remote:new", "release-notes:new"],
    );
    assert.match(codex.items[0]!.warnings.join(" "), /HA_TOKEN/);
    assert.equal(
      codex.items[1]!.defaultSelected,
      false,
      "switched off in Codex",
    );
    assert.equal(
      codex.unsupported.find((entry) =>
        entry.label.startsWith("Servers bundled"),
      )?.count,
      2,
    );
    assert.equal(
      byId("vscode").items[0]!.warnings.some((warning) =>
        warning.includes("${input:token}"),
      ),
      true,
    );
    assert.equal(byId("cursor").items[0]!.summary, "http://127.0.0.1:3845/sse");
    // Cline: a server it switched off is offered, unticked.
    assert.deepEqual(
      byId("cline").items.map((item) => [item.name, item.defaultSelected]),
      [
        ["Stripe", false],
        ["cline-fs", true],
      ],
    );
  } finally {
    await rm(environment.home, { recursive: true, force: true });
  }
});

test("an import adds what was ticked, never overwrites, and a re-run adds nothing", async () => {
  const environment = await fakeMacHome();
  const { home } = environment;
  try {
    const { servers, store } = memoryStore([
      blameServer("github", "gh-mcp", []),
    ]);
    const scan = await scanAgentSetups(environment, store);
    const github = scan.sources[0]!.items.find(
      (item) => item.name === "github",
    )!;
    assert.equal(github.state, "conflict");
    assert.equal(github.renameTo, "github-claude-desktop");
    const ids = (source: string, name: string) =>
      scan.sources
        .find((s) => s.id === source)!
        .items.find((i) => i.name === name)!.id;

    const first = await applyAgentImport(environment, store, [
      { id: ids("claude-desktop", "filesystem") },
      { id: github.id },
      { id: ids("claude-code", "dokploy") },
      { id: ids("codex", "home_assistant") },
      { id: ids("claude-code", "pdf") },
      { id: ids("codex", "release-notes") },
    ]);
    assert.deepEqual(
      first.outcomes.map((o) => `${o.name}:${o.status}`).sort(),
      [
        "dokploy:imported",
        "filesystem:imported",
        "github:skipped",
        "home_assistant:imported",
        "pdf:imported",
        "release-notes:imported",
      ],
    );
    assert.equal(servers.find((s) => s.name === "github")!.command, "gh-mcp");
    assert.equal(
      servers.find((s) => s.name === "dokploy")!.env!.DOKPLOY_API_KEY,
      secrets[0],
    );
    assert.equal(
      servers.find((s) => s.name === "home_assistant")!.disabled,
      true,
      "needs its token first",
    );
    assert.equal(
      await readFile(join(home, ".agents/skills/pdf/scripts/run.py"), "utf8"),
      "print('hi')\n",
    );
    assert.deepEqual((await readdir(join(home, ".agents/skills"))).sort(), [
      "pdf",
      "release-notes",
    ]);

    // Renamed on purpose.
    const renamed = await applyAgentImport(environment, store, [
      { id: github.id, rename: true },
    ]);
    assert.deepEqual(
      renamed.outcomes.map((o) => `${o.name}:${o.status}`),
      ["github-claude-desktop:renamed"],
    );

    // Run again: everything is present, nothing is added twice.
    const count = servers.length;
    const again = await scanAgentSetups(environment, store);
    const states = again.sources.flatMap((s) =>
      s.items
        .filter((i) => i.category !== "command" && i.state !== "in-place")
        .map((i) => `${i.name}:${i.state}`),
    );
    assert.equal(states.includes("filesystem:present"), true);
    assert.equal(states.includes("pdf:present"), true);
    assert.equal(states.includes("github:present"), false);
    const second = await applyAgentImport(environment, store, [
      { id: ids("claude-desktop", "filesystem") },
      { id: ids("claude-code", "pdf") },
    ]);
    assert.deepEqual(
      second.outcomes.map((o) => o.status),
      ["present", "present"],
    );
    assert.equal(servers.length, count);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a skill of the same name but another content is a conflict: skipped, or copied under a new name", async () => {
  const environment = await fakeMacHome();
  const { home } = environment;
  try {
    await mkdir(join(home, ".agents/skills/release-notes"), {
      recursive: true,
    });
    await writeFile(
      join(home, ".agents/skills/release-notes/SKILL.md"),
      "---\nname: release-notes\n---\nMine\n",
    );
    const { store } = memoryStore();
    const scan = await scanAgentSetups(environment, store);
    const skill = scan.sources
      .find((s) => s.id === "codex")!
      .items.find((i) => i.name === "release-notes")!;
    assert.equal(skill.state, "conflict");
    const skipped = await applyAgentImport(environment, store, [
      { id: skill.id },
    ]);
    assert.equal(skipped.outcomes[0]!.status, "skipped");
    assert.match(
      await readFile(
        join(home, ".agents/skills/release-notes/SKILL.md"),
        "utf8",
      ),
      /Mine/,
    );
    const renamed = await applyAgentImport(environment, store, [
      { id: skill.id, rename: true },
    ]);
    assert.equal(renamed.outcomes[0]!.status, "renamed");
    const copy = await readFile(
      join(home, ".agents/skills/release-notes-codex/SKILL.md"),
      "utf8",
    );
    assert.match(copy, /name: "release-notes-codex"/);
    assert.match(copy, /Write release notes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing and corrupt files are tolerated and nothing is created by a scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "blame-import-"));
  try {
    await writeFile(join(home, ".claude.json"), "{ not json");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex/config.toml"),
      "[mcp_servers.x\ncommand =",
    );
    const { store } = memoryStore();
    // Every source is listed; the two with corrupt files were found, and have nothing.
    const scan = await scanAgentSetups(
      scanEnvironment(home, { BLAME_AGENT_IMPORT_HOME: home }),
      store,
    );
    assert.deepEqual(
      scan.sources.map((source) => [
        source.id,
        source.detected,
        source.items.length,
      ]),
      [
        ["claude-desktop", false, 0],
        ["claude-code", true, 0],
        ["codex", true, 0],
        ["cursor", false, 0],
        ["vscode", false, 0],
        ["cline", false, 0],
        ["opencode", false, 0],
        ["kilo", false, 0],
        ["roo", false, 0],
        ["antigravity", false, 0],
        ["gemini", false, 0],
        ["qwen", false, 0],
        ["goose", false, 0],
        ["continue", false, 0],
        ["zed", false, 0],
      ],
    );
    assert.equal(
      await stat(join(home, ".agents")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the fake home hides the real session's variables; the real home honours them", () => {
  const real = {
    CODEX_HOME: "/data/codex",
    CLAUDE_CONFIG_DIR: "/data/claude",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  };
  const fake = scanEnvironment(
    "/home/me",
    { ...real, BLAME_AGENT_IMPORT_HOME: "/tmp/fake" },
    "linux",
  );
  assert.equal(fake.home, "/tmp/fake");
  assert.equal(codexFolder(fake), "/tmp/fake/.codex");
  assert.equal(claudeCodePaths(fake).json, "/tmp/fake/.claude.json");
  const custom = scanEnvironment("/home/me", real, "linux");
  assert.equal(codexFolder(custom), "/data/codex");
  assert.deepEqual(claudeCodePaths(custom), {
    folder: "/data/claude",
    json: "/data/claude/.claude.json",
  });
});

test("each system's folders", () => {
  const mac = scanEnvironment("/Users/me", {}, "darwin");
  assert.deepEqual(claudeDesktopFolders(mac), [
    "/Users/me/Library/Application Support/Claude",
  ]);
  assert.equal(
    vscodeMcpFile(mac),
    "/Users/me/Library/Application Support/Code/User/mcp.json",
  );
  const linux = scanEnvironment(
    "/home/me",
    { XDG_CONFIG_HOME: "/home/me/cfg" },
    "linux",
  );
  assert.deepEqual(claudeDesktopFolders(linux), ["/home/me/cfg/Claude"]);
  assert.equal(
    vscodeMcpFile(scanEnvironment("/home/me", {}, "linux")),
    "/home/me/.config/Code/User/mcp.json",
  );
  const windows = scanEnvironment(
    "C:\\Users\\me",
    { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "D:\\Local" },
    "win32",
  );
  assert.deepEqual(claudeDesktopFolders(windows), [
    "C:\\Users\\me\\AppData\\Roaming\\Claude",
    "D:\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude",
  ]);
  assert.equal(codexFolder(windows), "C:\\Users\\me\\.codex");
  assert.equal(
    vscodeMcpFile(windows),
    "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json",
  );
});

test("parsers: comments, Codex timeouts and every transport", () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,], }'), {
    a: "x//y",
    b: [1],
  });
  const parsed = parseCodexConfig(
    `[mcp_servers.a]\ncommand = "node"\ntool_timeout_sec = 120\n[mcp_servers.b]\nurl = "https://x.test/mcp"\n`,
  );
  assert.deepEqual(
    parsed.servers.map((s) => [s.name, s.transport, s.timeout]),
    [
      ["a", "stdio", 120],
      ["b", "streamableHttp", undefined],
    ],
  );
});
