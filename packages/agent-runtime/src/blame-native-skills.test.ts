import assert from "node:assert/strict";
import test from "node:test";

import {
  createUserInstructionConfigService,
  resolvePluginSkillDirectoriesFromPaths,
  type UserInstructionConfigService,
} from "@cline/sdk";

import { blameNativePluginPath } from "./cline-runtime.js";
import { BlameUserInstructionServices, skillScopeSystemPrompt } from "./user-instruction-services.js";

test("discovers and invokes Impeccable through Cline native skills", async () => {
  const skillDirectories = resolvePluginSkillDirectoriesFromPaths([
    blameNativePluginPath(),
  ]);
  assert.equal(skillDirectories.length, 1);
  assert.match(skillDirectories[0] ?? "", /blame-native\/skills$/);

  const service = createUserInstructionConfigService({
    skills: { directories: skillDirectories },
  });
  try {
    await service.start();
    const records = service.listRecords("skill");
    const impeccable = records.find(
      (record: { item: { name: string } }) => record.item.name === "impeccable",
    );
    assert.deepEqual(
      records.map((record: { item: { name: string } }) => record.item.name).sort(),
      ["component-preview", "impeccable"],
    );
    assert.match(impeccable?.item.description ?? "", /frontend task/);
    assert.match(impeccable?.item.description ?? "", /Mandatory/);
    assert.match(impeccable?.item.description ?? "", /before making design/);
    const prompt = skillScopeSystemPrompt(service);
    assert.match(prompt, /"name":"impeccable"/);
    assert.match(prompt, /Not for backend-only/);
    assert.doesNotMatch(prompt, /# Impeccable for Blame/);

    const executor = service.createSkillsExecutor?.();
    assert.ok(executor);
    assert.deepEqual(
      executor.configuredSkills
        ?.map((skill: { name: string }) => skill.name)
        .sort(),
      ["component-preview", "impeccable"],
    );
    const output = await executor("impeccable", "polish settings", {} as never);
    assert.match(output, /<command-name>impeccable<\/command-name>/);
    assert.match(output, /<command-args>polish settings<\/command-args>/);
    assert.match(output, /# Impeccable for Blame/);
    assert.match(output, /hard precondition/);
    assert.match(output, /consult_specialist/);
  } finally {
    service.stop();
  }
});

test("skill scope discovery omits disabled skills and leaves full loading available", () => {
  let invoked = false;
  const executor = Object.assign(() => { invoked = true; }, {
    configuredSkills: [
      { name: "enabled", description: "Use for the requested API migration." },
      { name: "disabled", description: "Do not expose", disabled: true },
    ],
  });
  const service = { createSkillsExecutor: () => executor } as unknown as UserInstructionConfigService;
  const prompt = skillScopeSystemPrompt(service);
  assert.match(prompt, /requested API migration/);
  assert.doesNotMatch(prompt, /disabled|Do not expose/);
  assert.equal(invoked, false);
  assert.equal(skillScopeSystemPrompt(), "");
});

test("skill scope snapshot is bounded without truncating a descriptor into a false scope", () => {
  const service = { createSkillsExecutor: () => ({ configuredSkills: [
    { name: "first", description: "Use only for deployment." },
    { name: "long", description: "x".repeat(20_000) + " Never use for deployment." },
  ] }) } as unknown as UserInstructionConfigService;
  const prompt = skillScopeSystemPrompt(service);
  assert.match(prompt, /Use only for deployment/);
  assert.match(prompt, /skills tool remains available/);
  assert.doesNotMatch(prompt, /"name":"long"/);
  assert.ok(prompt.length < 17_000);
});

test("keeps session startup available when the skill service fails", async () => {
  let stopped = false;
  const services = new BlameUserInstructionServices(
    () =>
      ({
        async start() {
          throw new Error("skill watcher unavailable");
        },
        stop() {
          stopped = true;
        },
      }) as UserInstructionConfigService,
  );

  const service = await services.start({
    cwd: "/tmp/blame-skill-fallback",
    pluginPaths: ["/tmp/blame-native/index.js"],
    sessionId: "fallback-session",
    workspaceRoot: "/tmp/blame-skill-fallback",
  });

  assert.equal(service, undefined);
  assert.equal(stopped, true);
});

test("the component preview skill explains the recipes and the tool", async () => {
  const service = createUserInstructionConfigService({
    skills: {
      directories: resolvePluginSkillDirectoriesFromPaths([blameNativePluginPath()]),
    },
  });
  try {
    await service.start();
    const executor = service.createSkillsExecutor?.();
    assert.ok(executor);
    const output = await executor("component-preview", "settings panel", {} as never);
    assert.match(output, /\.blame-preview\.html/);
    assert.match(output, /app\/blame-preview\/<name>\/page\.tsx/);
    assert.match(output, /open_component_preview/);
    assert.match(output, /take_snapshot/);
    assert.match(output, /finish_task/);
    assert.match(output, /Never change the project's real source/);
  } finally {
    service.stop();
  }
});
