import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPortOwner,
  inspectLocalPort,
  parseLsofProcess,
  parseWindowsProcess,
  previewPort,
} from "./local-port-owner.ts";

test("a process running in the project folder is the project's app", () => {
  assert.equal(
    classifyPortOwner(
      { cwd: "/Users/raph/site-a" },
      "/Users/raph/site-a",
      "darwin",
    ),
    "project",
  );
  assert.equal(
    classifyPortOwner(
      { cwd: "/Users/raph/site-a/apps/web" },
      "/Users/raph/site-a/",
      "linux",
    ),
    "project",
  );
  // macOS folders ignore case.
  assert.equal(
    classifyPortOwner(
      { cwd: "/users/raph/Site-A" },
      "/Users/raph/site-a",
      "darwin",
    ),
    "project",
  );
});

test("a process in another folder belongs to another app", () => {
  assert.equal(
    classifyPortOwner(
      { cwd: "/Users/raph/site-b" },
      "/Users/raph/site-a",
      "darwin",
    ),
    "other",
  );
  // A folder whose name only starts the same way is another project.
  assert.equal(
    classifyPortOwner(
      { cwd: "/Users/raph/site-a-old" },
      "/Users/raph/site-a",
      "linux",
    ),
    "other",
  );
});

test("a process Blame cannot place stays unknown", () => {
  assert.equal(classifyPortOwner(undefined, "/p", "darwin"), "unknown");
  // Docker's port proxy runs at the root.
  assert.equal(
    classifyPortOwner(
      { cwd: "/", processName: "com.docker.backend" },
      "/p",
      "darwin",
    ),
    "unknown",
  );
  assert.equal(
    classifyPortOwner({ processName: "node.exe" }, "C:\\p", "win32"),
    "unknown",
  );
});

test("on Windows the command line places the process", () => {
  const project = "C:\\Users\\raph\\site-a";
  assert.equal(
    classifyPortOwner(
      {
        commandLine:
          '"node.exe" C:\\Users\\Raph\\site-a\\node_modules\\next\\dist\\bin\\next dev',
      },
      project,
      "win32",
    ),
    "project",
  );
  assert.equal(
    classifyPortOwner(
      { commandLine: "node C:\\Users\\raph\\site-a-old\\server.js" },
      project,
      "win32",
    ),
    "unknown",
  );
});

test("reads the listening process from lsof and PowerShell", () => {
  assert.deepEqual(parseLsofProcess("p4242\ncnode\nf23\n"), {
    pid: 4242,
    processName: "node",
  });
  assert.equal(parseLsofProcess(""), undefined);
  assert.deepEqual(
    parseWindowsProcess(
      '{"pid":812,"name":"node.exe","commandLine":"node server.js"}',
    ),
    { pid: 812, processName: "node.exe", commandLine: "node server.js" },
  );
  assert.equal(parseWindowsProcess("  "), undefined);
});

test("a free port has no owner to look up", async () => {
  let looked = false;
  const result = await inspectLocalPort(
    { port: 3000, projectPath: "/p" },
    {
      listening: async () => false,
      owner: async () => {
        looked = true;
        return undefined;
      },
      platform: "darwin",
    },
  );
  assert.deepEqual(result, { status: "free" });
  assert.equal(looked, false);
});

test("a busy port reports its owner, and an unreadable one stays unknown", async () => {
  const owned = await inspectLocalPort(
    { port: 3000, projectPath: "/Users/raph/site-a" },
    {
      listening: async () => true,
      owner: async () => ({
        cwd: "/Users/raph/site-b",
        pid: 9,
        processName: "node",
      }),
      platform: "darwin",
    },
  );
  assert.deepEqual(owned, {
    status: "busy",
    owner: "other",
    cwd: "/Users/raph/site-b",
    pid: 9,
    processName: "node",
  });
  const unreadable = await inspectLocalPort(
    { port: 3000, projectPath: "/p" },
    {
      listening: async () => true,
      owner: async () => {
        throw new Error("lsof missing");
      },
      platform: "linux",
    },
  );
  assert.deepEqual(unreadable, { status: "busy", owner: "unknown" });
});

test("finds the local port of a preview address", () => {
  assert.equal(previewPort("http://localhost:3000/"), 3000);
  assert.equal(previewPort("localhost:5173"), 5173);
  assert.equal(previewPort("http://127.0.0.1"), 80);
  assert.equal(previewPort("https://app.example.com:3000"), undefined);
  assert.equal(previewPort(undefined), undefined);
});
