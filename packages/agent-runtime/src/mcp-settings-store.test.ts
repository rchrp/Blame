import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  McpSettingsUnreadableError,
  mcpSettingsBackupDirectory,
  readMcpSettings,
  readMcpSettingsRecovery,
  updateMcpSettings,
} from "./mcp-settings-store.js";

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-store-"));
  return { directory, path: join(directory, "mcp-settings.json") };
}

const dokploy = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@dokploy/mcp"],
  env: { DOKPLOY_TOKEN: "fake-token" },
};

test("a missing file is an empty list and is not created by a read", async () => {
  const { directory, path } = await scratch();
  assert.deepEqual(await readMcpSettings(path), { mcpServers: {} });
  assert.deepEqual(await readdir(directory), []);
});

test("an unreadable file is moved aside, never overwritten with an empty list", async () => {
  const { directory, path } = await scratch();
  await writeFile(path, '{"mcpServers": {"Dokploy": {"command": "np');
  const settings = await readMcpSettings(path, { unreadable: "quarantine" });
  assert.deepEqual(settings, { mcpServers: {} });
  const names = await readdir(directory);
  const aside = names.find((name) => name.includes(".unreadable-"));
  assert.ok(aside, "the broken file is kept");
  assert.match(await readFile(join(directory, aside), "utf8"), /Dokploy/);
  const notice = await readMcpSettingsRecovery(path);
  assert.equal(notice?.movedTo, join(directory, aside));
});

test("reading an unreadable file without quarantine throws and leaves it alone", async () => {
  const { path } = await scratch();
  await writeFile(path, "not json");
  await assert.rejects(readMcpSettings(path), McpSettingsUnreadableError);
  assert.equal(await readFile(path, "utf8"), "not json");
  await assert.rejects(
    updateMcpSettings(path, (settings) => {
      settings.mcpServers.x = { command: "x" };
    }),
    McpSettingsUnreadableError,
  );
  assert.equal(await readFile(path, "utf8"), "not json");
});

test("an unreadable file comes back from the last backup", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Other = { type: "stdio", command: "other" };
  });
  await writeFile(path, "{ truncated");
  const settings = await readMcpSettings(path, { unreadable: "quarantine" });
  // The backup is the state before the second change: Dokploy is not lost.
  assert.deepEqual(settings.mcpServers.Dokploy, dokploy);
  assert.ok((await readMcpSettingsRecovery(path))?.restoredFrom);
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).mcpServers.Dokploy,
    dokploy,
  );
});

test("a rewrite keeps the previous content in a backup", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = { ...dokploy, args: ["changed"] };
  });
  const directory = mcpSettingsBackupDirectory(path);
  const [backup] = await readdir(directory);
  assert.ok(backup);
  const saved = JSON.parse(await readFile(join(directory, backup), "utf8"));
  assert.deepEqual(saved.mcpServers.Dokploy, dokploy);
});

test("rapid rewrites keep the first backup, the state before all of them", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  for (const index of [1, 2, 3]) {
    await updateMcpSettings(path, (settings) => {
      settings.mcpServers.Dokploy = { ...dokploy, args: [String(index)] };
    });
  }
  const directory = mcpSettingsBackupDirectory(path);
  const backups = await readdir(directory);
  assert.equal(backups.length, 1);
  const saved = JSON.parse(await readFile(join(directory, backups[0]), "utf8"));
  assert.deepEqual(saved.mcpServers.Dokploy, dokploy);
});

test("a change that would empty a file that holds servers is refused", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  await assert.rejects(
    updateMcpSettings(path, () => ({ mcpServers: {} })),
    /Refusing to remove every MCP server/,
  );
  assert.deepEqual((await readMcpSettings(path)).mcpServers.Dokploy, dokploy);
  const emptied = await updateMcpSettings(path, () => ({ mcpServers: {} }), {
    allowEmpty: true,
  });
  assert.deepEqual(emptied.mcpServers, {});
});

test("concurrent writers (two processes' worth) lose no update", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      updateMcpSettings(path, (settings) => {
        settings.mcpServers[`Server ${index}`] = { command: `c${index}` };
      }),
    ),
  );
  const settings = await readMcpSettings(path);
  assert.equal(Object.keys(settings.mcpServers).length, 13);
  assert.deepEqual(settings.mcpServers.Dokploy, dokploy);
});

test("no temporary or lock file stays behind", async () => {
  const { directory, path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  assert.deepEqual(await readdir(directory), ["mcp-settings.json"]);
});

test("unchanged content is not rewritten", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  await updateMcpSettings(path, () => undefined);
  await assert.rejects(readdir(mcpSettingsBackupDirectory(path)));
});

test("other keys of the file survive a rewrite", async () => {
  const { path } = await scratch();
  await writeFile(
    path,
    JSON.stringify({ version: 2, mcpServers: { Dokploy: dokploy } }),
  );
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Other = { command: "other" };
  });
  assert.equal((await readMcpSettings(path)).version, 2);
});

test("separate processes lose no update either", async () => {
  const { path } = await scratch();
  await updateMcpSettings(path, (settings) => {
    settings.mcpServers.Dokploy = dokploy;
  });
  const module = new URL("./mcp-settings-store.js", import.meta.url).href;
  const script = `
    import { updateMcpSettings } from ${JSON.stringify(module)};
    const [path, prefix] = process.argv.slice(1);
    for (let index = 0; index < 8; index++) {
      await updateMcpSettings(path, (settings) => {
        settings.mcpServers[prefix + index] = { command: "c" };
      });
    }
  `;
  await Promise.all(
    ["a", "b", "c"].map(
      (prefix) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", script, path, prefix],
            { stdio: "inherit" },
          );
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
          );
        }),
    ),
  );
  const settings = await readMcpSettings(path);
  assert.equal(Object.keys(settings.mcpServers).length, 25);
  assert.deepEqual(settings.mcpServers.Dokploy, dokploy);
});

test("a file without an mcpServers key is an empty list, not a broken file", async () => {
  const { directory, path } = await scratch();
  await writeFile(path, "{}");
  assert.deepEqual(await readMcpSettings(path, { unreadable: "quarantine" }), {
    mcpServers: {},
  });
  assert.deepEqual(await readdir(directory), ["mcp-settings.json"]);
});

test("a broken file is moved aside once, even when several readers meet it", async () => {
  const { directory, path } = await scratch();
  await writeFile(path, "{ truncated");
  await Promise.all(
    Array.from({ length: 4 }, () =>
      readMcpSettings(path, { unreadable: "quarantine" }),
    ),
  );
  const aside = (await readdir(directory)).filter((name) =>
    name.includes(".unreadable-"),
  );
  assert.equal(aside.length, 1);
});
