import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanEnvironment } from "./environment.ts";
import {
  applyAgentImport,
  scanAgentSetups,
  type BlameMcpStore,
} from "./import.ts";
import { fingerprint } from "./servers.ts";
import type { McpServerConfig } from "@blame/app";

// Fake secrets: they must never come out of a scan.
const secrets = [
  "oc-secret-0001",
  "gm-secret-0002",
  "gs-secret-0003",
  "zed-secret-0004",
  "cn-secret-0005",
];

const files: Record<string, string> = {
  ".config/opencode/opencode.jsonc": `// OpenCode
{
  "mcp": {
    "servers": {
      "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp", "headers": { "CONTEXT7_API_KEY": "${secrets[0]}" } },
      "fs": { "type": "local", "command": ["npx", "-y", "fs-mcp", "/tmp"], "environment": { "TOKEN": "${secrets[0]}" } },
      "old": { "type": "local", "command": ["node", "old.js"], "disabled": true },
    },
  },
}`,
  ".config/opencode/skills/oc-skill/SKILL.md":
    "---\nname: oc-skill\ndescription: From OpenCode\n---\nBody\n",
  ".config/kilo/kilo.jsonc": JSON.stringify({
    mcp: {
      kilo_server: {
        type: "local",
        command: ["uvx", "kilo-mcp"],
        enabled: false,
        timeout: 20000,
      },
    },
  }),
  "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json":
    JSON.stringify({
      mcpServers: {
        roo_remote: {
          type: "streamable-http",
          url: "https://roo.example.com/mcp",
        },
        roo_local: {
          command: "node",
          args: ["r.js"],
          disabled: true,
          alwaysAllow: ["x"],
        },
      },
    }),
  ".gemini/settings.json": JSON.stringify({
    theme: "dark",
    mcpServers: {
      sse_one: {
        url: "https://gemini.example.com/sse",
        headers: { "X-Key": secrets[1] },
      },
      http_one: { httpUrl: "https://gemini.example.com/mcp", timeout: 30000 },
      local_one: {
        command: "node",
        args: ["server.js"],
        env: { API_KEY: secrets[1] },
        trust: true,
      },
    },
  }),
  ".gemini/config/mcp_config.json": JSON.stringify({
    mcpServers: {
      agy_remote: {
        serverUrl: "https://agy.example.com/mcp",
        headers: { Authorization: "Bearer ${secrets[1]}" },
        timeoutSeconds: 120,
      },
      agy_local: {
        command: "node",
        args: ["a.js"],
        env: { K: "${secrets[1]}" },
        disabled: true,
      },
    },
  }),
  ".gemini/config/skills/agy-skill/SKILL.md":
    "---\nname: agy-skill\ndescription: From Antigravity\n---\nBody\n",
  ".gemini/skills/g-skill/SKILL.md": "---\nname: g-skill\n---\nBody\n",
  ".qwen/settings.json": JSON.stringify({
    mcpServers: { qwen_local: { command: "qwen-mcp" } },
  }),
  ".config/goose/config.yaml": `GOOSE_PROVIDER: openai
extensions:
  developer:
    type: builtin
    name: developer
    enabled: true
  github:
    type: stdio
    name: github
    cmd: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    envs:
      GITHUB_TOKEN: ${secrets[2]}
    enabled: true
  remote:
    type: streamable_http
    name: remote
    uri: https://goose.example.com/mcp
    enabled: false
  keyed:
    type: stdio
    name: keyed
    cmd: node
    args: [k.js]
    env_keys: [KEYED_TOKEN]
`,
  ".config/zed/settings.json": `// Zed
{
  "theme": "One Dark",
  "context_servers": {
    "zed-fs": { "command": { "path": "npx", "args": ["-y", "fs-mcp"], "env": { "TOKEN": "${secrets[3]}" } } },
    "zed-remote": { "url": "https://zed.example.com/mcp", "headers": { "Authorization": "Bearer ${secrets[3]}" } },
    "from-extension": { "source": "extension", "settings": {} },
  },
}`,
  ".continue/mcpServers/tools.json": JSON.stringify({
    mcpServers: {
      cn_json: { command: "cn", args: ["a"], env: { K: secrets[4] } },
    },
  }),
  ".continue/mcpServers/more.yaml": `name: More
mcpServers:
  - name: cn_yaml
    type: sse
    url: https://continue.example.com/sse
  - name: cn_yaml_local
    command: uvx
    args: [thing]
`,
};

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), "blame-import-oss-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), content);
  }
  return home;
}

function memoryStore() {
  const servers: McpServerConfig[] = [];
  const store: BlameMcpStore = {
    list: async () =>
      servers.map((server) => ({
        name: server.name,
        fingerprint: fingerprint(server),
      })),
    add: async (input) => {
      servers.push(...input);
      return input.map((server) => server.name);
    },
  };
  return { servers, store };
}

test("the open-source tools' servers and skills are read, with their secrets hidden", async () => {
  const home = await fakeHome();
  try {
    const environment = scanEnvironment(home, {
      BLAME_AGENT_IMPORT_HOME: home,
    });
    const scan = await scanAgentSetups(environment, memoryStore().store);
    const json = JSON.stringify(scan);
    for (const secret of secrets)
      assert.equal(json.includes(secret), false, secret);
    const names = (id: string) =>
      scan.sources
        .find((source) => source.id === id)!
        .items.map(
          (item) =>
            `${item.category}:${item.name}${item.defaultSelected ? "" : " (unticked)"}`,
        );
    assert.deepEqual(names("opencode"), [
      "mcp:context7",
      "mcp:fs",
      "mcp:old (unticked)",
      "skill:oc-skill",
    ]);
    assert.deepEqual(names("kilo"), ["mcp:kilo_server (unticked)"]);
    assert.deepEqual(names("roo"), [
      "mcp:roo_remote",
      "mcp:roo_local (unticked)",
    ]);
    assert.deepEqual(names("antigravity"), [
      "mcp:agy_remote",
      "mcp:agy_local (unticked)",
      "skill:agy-skill",
    ]);
    assert.deepEqual(names("gemini"), [
      "mcp:sse_one",
      "mcp:http_one",
      "mcp:local_one",
      "skill:g-skill",
    ]);
    assert.deepEqual(names("qwen"), ["mcp:qwen_local"]);
    assert.deepEqual(names("goose"), [
      "mcp:github",
      "mcp:remote (unticked)",
      "mcp:keyed",
    ]);
    assert.deepEqual(names("zed"), ["mcp:zed-fs", "mcp:zed-remote"]);
    assert.deepEqual(names("continue"), [
      "mcp:cn_yaml",
      "mcp:cn_yaml_local",
      "mcp:cn_json",
    ]);

    const goose = scan.sources.find((source) => source.id === "goose")!;
    assert.equal(
      goose.unsupported[0]!.count,
      1,
      "the built-in developer extension",
    );
    assert.match(goose.items[2]!.warnings.join(" "), /KEYED_TOKEN/);
    assert.deepEqual(goose.items[0]!.secrets, ["GITHUB_TOKEN"]);
    assert.equal(
      scan.sources.find((s) => s.id === "opencode")!.items[0]!.secrets[0],
      "CONTEXT7_API_KEY",
    );
    // Not on this computer: listed, not detected.
    assert.equal(scan.sources.find((s) => s.id === "cursor")!.detected, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("each tool's transports and units come out right in what is imported", async () => {
  const home = await fakeHome();
  try {
    const environment = scanEnvironment(home, {
      BLAME_AGENT_IMPORT_HOME: home,
    });
    const { servers, store } = memoryStore();
    const scan = await scanAgentSetups(environment, store);
    const ids = scan.sources.flatMap((source) =>
      source.items.map((item) => item.id),
    );
    const result = await applyAgentImport(
      environment,
      store,
      ids.map((id) => ({ id })),
    );
    assert.equal(
      result.outcomes.some((outcome) => outcome.status === "failed"),
      false,
    );
    const server = (name: string) =>
      servers.find((candidate) => candidate.name === name)!;
    // OpenCode: the command array is split, `environment` is the env.
    assert.deepEqual(
      [server("fs").command, server("fs").args, server("fs").env],
      ["npx", ["-y", "fs-mcp", "/tmp"], { TOKEN: secrets[0] }],
    );
    assert.equal(server("context7").transport, "streamableHttp");
    assert.equal(server("old").disabled, true);
    // Kilo: milliseconds become seconds.
    assert.equal(server("kilo_server").timeout, 20);
    // Gemini: `url` is SSE, `httpUrl` is Streamable HTTP.
    assert.equal(server("sse_one").transport, "sse");
    assert.equal(server("http_one").transport, "streamableHttp");
    assert.equal(server("http_one").timeout, 30);
    // Antigravity: `serverUrl`, `timeoutSeconds` in seconds.
    assert.deepEqual(
      [
        server("agy_remote").transport,
        server("agy_remote").url,
        server("agy_remote").timeout,
      ],
      ["streamableHttp", "https://agy.example.com/mcp", 120],
    );
    assert.equal(server("agy_local").disabled, true);
    assert.equal(server("roo_remote").transport, "streamableHttp");
    assert.deepEqual(
      [server("github").command, server("github").env],
      ["npx", { GITHUB_TOKEN: secrets[2] }],
    );
    // Goose's keyring values are missing: switched off.
    assert.equal(server("keyed").disabled, true);
    assert.deepEqual(
      [server("zed-fs").command, server("zed-fs").args],
      ["npx", ["-y", "fs-mcp"]],
    );
    assert.equal(server("zed-remote").transport, "streamableHttp");
    assert.equal(server("cn_yaml").transport, "sse");
    // Skills of tools Blame does not read in place are copied.
    assert.match(
      await readFile(join(home, ".agents/skills/oc-skill/SKILL.md"), "utf8"),
      /From OpenCode/,
    );
    assert.match(
      await readFile(join(home, ".agents/skills/g-skill/SKILL.md"), "utf8"),
      /g-skill/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
