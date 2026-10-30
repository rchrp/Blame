import assert from "node:assert/strict";
import test from "node:test";
import {
  readGitIdentity,
  saveGitIdentity,
  validGitIdentity,
} from "./git-identity.ts";

function unset() {
  return Object.assign(new Error("exit 1"), { code: 1 });
}

function fakeGit(config: Record<string, string>) {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "--version") return "git version 2.50.0\n";
    if (args[0] === "config" && args[1] === "--get") {
      const value = config[args[2]!];
      if (value === undefined) throw unset();
      return `${value}\n`;
    }
    if (args[0] === "config" && args[1] === "--global") {
      config[args[2]!] = args[3]!;
      return "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { calls, config, git };
}

test("a name and an email make an identity", async () => {
  const { git } = fakeGit({
    "user.name": "Ada Lovelace",
    "user.email": "ada@example.com",
  });
  assert.deepEqual(await readGitIdentity({}, git), {
    available: true,
    configured: true,
    email: "ada@example.com",
    name: "Ada Lovelace",
  });
});

test("a missing email or Blame's old placeholder is not configured", async () => {
  const missing = await readGitIdentity(
    {},
    fakeGit({ "user.name": "Ada" }).git,
  );
  assert.equal(missing.configured, false);
  assert.equal(missing.name, "Ada");
  const placeholder = await readGitIdentity(
    {},
    fakeGit({ "user.name": "ada", "user.email": "blame@example.local" }).git,
  );
  assert.equal(placeholder.configured, false);
  assert.equal(placeholder.email, "");
});

test("without Git there is nothing to ask", async () => {
  const identity = await readGitIdentity({}, async () => {
    throw new Error("Git is not installed");
  });
  assert.deepEqual(identity, {
    available: false,
    configured: false,
    email: "",
    name: "",
  });
});

test("other Git failures are not taken for an unset value", async () => {
  await assert.rejects(
    readGitIdentity({}, async (args) => {
      if (args[0] === "--version") return "git version 2.50.0";
      throw Object.assign(new Error("bad config"), { code: 128 });
    }),
    /bad config/,
  );
});

test("saves a trimmed identity in the global settings", async () => {
  const { calls, config, git } = fakeGit({});
  assert.deepEqual(
    await saveGitIdentity({ name: "  Ada  ", email: " ada@example.com " }, git),
    { email: "ada@example.com", name: "Ada" },
  );
  assert.deepEqual(calls, [
    ["config", "--global", "user.name", "Ada"],
    ["config", "--global", "user.email", "ada@example.com"],
  ]);
  assert.equal(config["user.email"], "ada@example.com");
});

test("refuses what Git would refuse", () => {
  assert.throws(() => validGitIdentity({ name: "", email: "a@b.c" }), /name/);
  assert.throws(
    () => validGitIdentity({ name: "Ada <ada>", email: "a@b.c" }),
    /name/,
  );
  assert.throws(() => validGitIdentity({ name: "Ada", email: "ada" }), /email/);
  assert.throws(
    () => validGitIdentity({ name: "Ada", email: "blame@example.local" }),
    /email/,
  );
  assert.deepEqual(validGitIdentity({ name: "Ada", email: "ada@localhost" }), {
    email: "ada@localhost",
    name: "Ada",
  });
});
