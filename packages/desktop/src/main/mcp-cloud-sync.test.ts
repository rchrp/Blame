import {
  readMcpSettings,
  updateMcpSettings,
} from "@blame/agent-runtime/mcp-settings-store";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cloudDisabled,
  cloudOwner,
  completedCloudMetadata,
  detachCloudServers,
  localSetupRequired,
  mergeCloudServers,
  metadataWithSyncMode,
  syncMode,
  type McpSettings,
} from "./mcp-cloud-sync.ts";

const userId = "01981221-2b74-7bc0-a1f5-9f9c58f0e050";

test("disables a cloud server until its local setup is completed", () => {
  const merged = mergeCloudServers(emptySettings(), userId, [
    cloudServer(false),
  ]);
  const server = merged.mcpServers.Dokploy;

  assert.ok(server);
  assert.equal(server.disabled, true);
  assert.equal(localSetupRequired(server), true);
  assert.equal(cloudDisabled(server), false);
  assert.equal(cloudOwner(server), userId);
  assert.equal(server.timeout, 45);
});

test("keeps a cloud placeholder incomplete across repeated merges", () => {
  const firstMerge = mergeCloudServers(emptySettings(), userId, [
    cloudServer(false),
  ]);
  const secondMerge = mergeCloudServers(firstMerge, userId, [
    cloudServer(false),
  ]);
  const server = secondMerge.mcpServers.Dokploy;

  assert.ok(server);
  assert.equal(server.disabled, true);
  assert.equal(localSetupRequired(server), true);
  assert.equal(cloudDisabled(server), false);
});

test("preserves a disabled cloud state while local setup is incomplete", () => {
  const merged = mergeCloudServers(emptySettings(), userId, [
    cloudServer(true),
  ]);
  const server = merged.mcpServers.Dokploy;

  assert.ok(server);
  assert.equal(server.disabled, true);
  assert.equal(localSetupRequired(server), true);
  assert.equal(cloudDisabled(server), true);
});

test("adopts a matching local server without losing local-only fields", () => {
  const settings: McpSettings = {
    mcpServers: {
      Dokploy: {
        args: ["-y", "@dokploy/mcp"],
        command: "npx",
        disabled: false,
        env: { DOKPLOY_TOKEN: "secret" },
        type: "stdio",
      },
    },
  };

  const merged = mergeCloudServers(settings, userId, [cloudServer(false)]);
  const server = merged.mcpServers.Dokploy;

  assert.ok(server);
  assert.deepEqual(server.args, ["-y", "@dokploy/mcp"]);
  assert.deepEqual(server.env, { DOKPLOY_TOKEN: "secret" });
  assert.equal(server.disabled, false);
  assert.equal(localSetupRequired(server), false);
});

test("clears setup metadata while preserving cloud ownership", () => {
  const merged = mergeCloudServers(emptySettings(), userId, [
    cloudServer(false),
  ]);
  const server = merged.mcpServers.Dokploy;

  assert.ok(server);
  const metadata = completedCloudMetadata(server);
  assert.equal(metadata?.blameCloudUserId, userId);
  assert.equal(metadata?.blameCloudLocalSetupRequired, undefined);
  assert.equal(metadata?.blameCloudDisabled, undefined);
});

function emptySettings(): McpSettings {
  return { mcpServers: {} };
}

function cloudServer(disabled: boolean) {
  return {
    command: "npx",
    disabled,
    name: "Dokploy",
    timeout: 45,
    transport: "stdio" as const,
  };
}

// Reproduction of the "Setup required" that came back after every update.

test("a server added by hand after the first sync keeps its arguments and secrets", () => {
  // `mcp:save` writes no owner metadata for a new server, and the panel merges
  // again as soon as the cloud copy it just saved comes back.
  const settings: McpSettings = {
    mcpServers: {
      Dokploy: {
        args: ["-y", "@dokploy/mcp"],
        command: "npx",
        disabled: false,
        env: { DOKPLOY_TOKEN: "fake-token" },
        type: "stdio",
      },
    },
  };
  const merged = mergeCloudServers(settings, userId, [cloudServer(false)]);
  const server = merged.mcpServers.Dokploy;
  assert.ok(server);
  assert.deepEqual(server.args, ["-y", "@dokploy/mcp"]);
  assert.deepEqual(server.env, { DOKPLOY_TOKEN: "fake-token" });
  assert.equal(server.disabled, false);
  assert.equal(localSetupRequired(server), false);
});

test("a server written without a transport type is still recognized as a command", () => {
  // Files written by hand or imported from other tools say `command` and no
  // `type`; Settings reads them as local commands.
  const settings: McpSettings = {
    mcpServers: {
      Dokploy: {
        args: ["-y", "@dokploy/mcp"],
        command: "npx",
        env: { DOKPLOY_TOKEN: "fake-token" },
        metadata: { blameCloudUserId: userId },
      },
    },
  };
  const merged = mergeCloudServers(settings, userId, [cloudServer(false)]);
  const server = merged.mcpServers.Dokploy;
  assert.ok(server);
  assert.deepEqual(server.args, ["-y", "@dokploy/mcp"]);
  assert.equal(localSetupRequired(server), false);
});

test("a server another account synced is not rebuilt by the next account", () => {
  const otherUser = "01981221-2b74-7bc0-a1f5-000000000001";
  const settings: McpSettings = {
    mcpServers: {
      Dokploy: {
        args: ["-y", "@dokploy/mcp"],
        command: "npx",
        disabled: false,
        env: { DOKPLOY_TOKEN: "fake-token" },
        metadata: { blameCloudUserId: otherUser },
        type: "stdio",
      },
    },
  };
  const merged = mergeCloudServers(settings, userId, [cloudServer(false)]);
  const server = merged.mcpServers.Dokploy;
  assert.ok(server);
  assert.deepEqual(server.env, { DOKPLOY_TOKEN: "fake-token" });
  assert.equal(localSetupRequired(server), false);
});

// What the rules promise once a server is set up on this computer.

const configured = {
  args: ["-y", "@dokploy/mcp"],
  command: "npx",
  cwd: "/work",
  disabled: false,
  env: { DOKPLOY_TOKEN: "fake-token" },
  oauth: { tokens: { access_token: "fake-access" } },
  timeout: 45,
  type: "stdio",
};

test("every merge keeps a configured server whole, whatever the account holds", () => {
  const cloudShapes = [
    [],
    [cloudServer(true)],
    [{ ...cloudServer(false), command: "uvx" }],
    [
      {
        ...cloudServer(false),
        transport: "streamableHttp" as const,
        url: "https://x.example/mcp",
      },
    ],
  ];
  for (const owner of [
    undefined,
    userId,
    "01981221-2b74-7bc0-a1f5-000000000001",
  ]) {
    for (const cloud of cloudShapes) {
      const settings: McpSettings = {
        mcpServers: {
          Dokploy: owner
            ? { ...configured, metadata: { blameCloudUserId: owner } }
            : { ...configured },
        },
      };
      const merged = mergeCloudServers(settings, userId, cloud).mcpServers
        .Dokploy;
      assert.ok(
        merged,
        `kept (owner ${owner}, cloud ${JSON.stringify(cloud)})`,
      );
      for (const key of ["args", "cwd", "env", "oauth"] as const) {
        assert.deepEqual(merged[key], configured[key]);
      }
      assert.equal(localSetupRequired(merged), false);
    }
  }
});

test("migrates an old file: owner, setup and disabled flags survive untouched", () => {
  // The shape older versions wrote: one synced and completed, one still a
  // placeholder from the account, one added by hand.
  const old: McpSettings = {
    mcpServers: {
      Done: {
        ...configured,
        metadata: { blameCloudUserId: userId },
      },
      Waiting: {
        command: "npx",
        disabled: true,
        timeout: 30,
        type: "stdio",
        metadata: {
          blameCloudUserId: userId,
          blameCloudLocalSetupRequired: true,
          blameCloudDisabled: false,
        },
      },
      ByHand: { command: "node", args: ["server.js"], type: "stdio" },
    },
  };
  const merged = mergeCloudServers(old, userId, [
    { ...cloudServer(false), name: "Done" },
    { ...cloudServer(false), name: "Waiting", timeout: 30 },
  ]);
  assert.deepEqual(merged.mcpServers.Done.env, configured.env);
  assert.equal(cloudOwner(merged.mcpServers.Done), userId);
  assert.equal(localSetupRequired(merged.mcpServers.Waiting), true);
  assert.equal(cloudDisabled(merged.mcpServers.Waiting), false);
  assert.deepEqual(merged.mcpServers.ByHand, old.mcpServers.ByHand);
  assert.equal(syncMode(merged.mcpServers.Done), "account");
});

test("signing out removes only what was never set up here", () => {
  const settings: McpSettings = {
    mcpServers: {
      Done: { ...configured, metadata: { blameCloudUserId: userId } },
      Waiting: {
        command: "npx",
        disabled: true,
        type: "stdio",
        metadata: {
          blameCloudUserId: userId,
          blameCloudLocalSetupRequired: true,
        },
      },
      Other: { command: "node", type: "stdio" },
    },
  };
  const detached = detachCloudServers(settings, userId);
  assert.deepEqual(Object.keys(detached.mcpServers), ["Done", "Other"]);
  assert.deepEqual(detached.mcpServers.Done.env, configured.env);
});

test("a server kept on this device is never touched by the account", () => {
  const settings: McpSettings = {
    mcpServers: {
      Dokploy: {
        ...configured,
        metadata: metadataWithSyncMode(undefined, "device"),
      },
    },
  };
  const merged = mergeCloudServers(settings, userId, [
    { ...cloudServer(true), command: "uvx" },
  ]);
  assert.deepEqual(merged.mcpServers.Dokploy, settings.mcpServers.Dokploy);
  assert.equal(syncMode(merged.mcpServers.Dokploy), "device");
});

test("a change made on another device arrives, the local setup stays", () => {
  const first = mergeCloudServers(
    { mcpServers: { Dokploy: { ...configured } } },
    userId,
    [cloudServer(false)],
  );
  const second = mergeCloudServers(first, userId, [
    { ...cloudServer(false), command: "pnpx", timeout: 90 },
  ]);
  const server = second.mcpServers.Dokploy;
  assert.equal(server.command, "pnpx");
  assert.equal(server.timeout, 90);
  assert.deepEqual(server.env, configured.env);
  assert.deepEqual(server.args, configured.args);
});

test("a change made here, not uploaded yet, wins over the account", () => {
  const first = mergeCloudServers(
    { mcpServers: { Dokploy: { ...configured } } },
    userId,
    [cloudServer(false)],
  );
  const edited: McpSettings = {
    mcpServers: { Dokploy: { ...first.mcpServers.Dokploy, command: "bunx" } },
  };
  const merged = mergeCloudServers(edited, userId, [cloudServer(false)]);
  assert.equal(merged.mcpServers.Dokploy.command, "bunx");
});

test("a server removed from the account stays here when it works here", () => {
  const first = mergeCloudServers(
    {
      mcpServers: {
        Dokploy: { ...configured },
        Waiting: { command: "npx", type: "stdio" },
      },
    },
    userId,
    [cloudServer(false), { ...cloudServer(false), name: "Waiting" }],
  );
  const placeholderOnly = mergeCloudServers(
    {
      mcpServers: {
        ...first.mcpServers,
        Fresh: {
          command: "npx",
          disabled: true,
          type: "stdio",
          metadata: {
            blameCloudUserId: userId,
            blameCloudLocalSetupRequired: true,
          },
        },
      },
    },
    userId,
    [],
  );
  assert.deepEqual(placeholderOnly.mcpServers.Dokploy.env, configured.env);
  assert.equal(syncMode(placeholderOnly.mcpServers.Dokploy), "device");
  assert.equal(placeholderOnly.mcpServers.Fresh, undefined);
});

test("names are matched ignoring case, so a rename of case never duplicates", () => {
  const merged = mergeCloudServers(
    { mcpServers: { dokploy: { ...configured } } },
    userId,
    [cloudServer(false)],
  );
  assert.deepEqual(Object.keys(merged.mcpServers), ["dokploy"]);
  assert.deepEqual(merged.mcpServers.dokploy.env, configured.env);
});

test("an old file on disk goes through the store and the merge without losing a field", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "mcp-merge-")),
    "mcp-settings.json",
  );
  const oldFile = {
    mcpServers: {
      Dokploy: {
        args: ["-y", "@dokploy/mcp"],
        command: "npx",
        disabled: false,
        env: { DOKPLOY_TOKEN: "fake-token" },
        metadata: { blameCloudUserId: userId },
        oauth: { tokens: { access_token: "fake-access" } },
        type: "stdio",
      },
      Linear: {
        disabled: true,
        headers: { Authorization: "Bearer fake" },
        metadata: {
          blameCloudUserId: userId,
          blameCloudLocalSetupRequired: true,
          blameCloudDisabled: false,
        },
        type: "streamableHttp",
        url: "https://mcp.linear.example/mcp",
      },
    },
  };
  await writeFile(path, JSON.stringify(oldFile, null, 2));
  const cloud = [
    cloudServer(false),
    {
      disabled: false,
      name: "Linear",
      transport: "streamableHttp" as const,
      url: "https://mcp.linear.example/mcp",
    },
  ];
  for (let run = 0; run < 3; run++) {
    await updateMcpSettings(path, (settings) =>
      mergeCloudServers(settings as McpSettings, userId, cloud),
    );
  }
  const after = (await readMcpSettings(path)) as McpSettings;
  assert.deepEqual(
    after.mcpServers.Dokploy.env,
    oldFile.mcpServers.Dokploy.env,
  );
  assert.deepEqual(
    after.mcpServers.Dokploy.oauth,
    oldFile.mcpServers.Dokploy.oauth,
  );
  assert.equal(after.mcpServers.Dokploy.disabled, false);
  assert.equal(localSetupRequired(after.mcpServers.Linear), true);
  assert.equal(cloudDisabled(after.mcpServers.Linear), false);
});
