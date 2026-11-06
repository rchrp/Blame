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

test("the component preview skill is listed only with its tool", async () => {
  const service = createUserInstructionConfigService({
    skills: {
      directories: resolvePluginSkillDirectoriesFromPaths([blameNativePluginPath()]),
    },
  });
  try {
    await service.start();
    const withTool = skillScopeSystemPrompt(service, ["finish_task", "open_component_preview"]);
    assert.match(withTool, /"name":"component-preview"/);
    assert.match(withTool, /after creating a UI component or changing how one renders/);
    assert.match(withTool, /even when the app's preview is available/);
    assert.match(withTool, /"name":"impeccable"/);
    for (const toolNames of [undefined, [], ["finish_task", "get_preview_devtools"]]) {
      const withoutTool = skillScopeSystemPrompt(service, toolNames);
      assert.match(withoutTool, /"name":"impeccable"/);
      assert.doesNotMatch(withoutTool, /component-preview|open_component_preview/);
    }
  } finally {
    service.stop();
  }
});

test("the component preview skill explains the preview file and the tool", async () => {
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
    assert.match(output, /<name>\.blame-preview\.tsx/);
    assert.match(output, /mount\(element, state\)/);
    assert.doesNotMatch(output, /\.blame-preview\.html|app\/blame-preview\//);
    assert.match(output, /open_component_preview/);
    assert.match(output, /take_snapshot/);
    assert.match(output, /finish_task/);
    assert.match(output, /Never change the project's real source/);
  } finally {
    service.stop();
  }
});

test("the component preview skill covers Next.js and React packages without Vite", async () => {
  const service = createUserInstructionConfigService({
    skills: {
      directories: resolvePluginSkillDirectoriesFromPaths([blameNativePluginPath()]),
    },
  });
  try {
    await service.start();
    const executor = service.createSkillsExecutor?.();
    assert.ok(executor);
    const output = await executor("component-preview", "pricing card", {} as never);
    assert.doesNotMatch(output, /have no component preview/);
    assert.match(output, /Blame's own Vite with `@vitejs\/plugin-react`/);
    assert.match(output, /PostCSS or Tailwind config and the `paths` of its `tsconfig\.json` apply/);
    assert.match(output, /`next\/link`, `next\/image`, `next\/navigation` and `next\/font\/\*` are small shims, in this server only/);
    assert.match(output, /`"use client"` files render as they are/);
    assert.match(
      output,
      /Only client components render\. A Server Component[^\n]*preview its client sub-components with the props it would pass them, or check that screen in the app/,
    );
  } finally {
    service.stop();
  }
});

test("the component preview skill makes the component preview the default visual check", async () => {
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
    assert.doesNotMatch(output, /Prefer the real app/);
    assert.match(output, /Component preview first\*\*, even when the app's preview is available/);
    assert.match(output, /App captures as a complement/);
    assert.match(output, /a whole screen, a flow, where the component sits in its page, navigation between screens/);
    assert.match(output, /The app alone only when the component preview costs more than the app/);
    assert.match(output, /heavy fakes \(several providers, global state, real data\)/);
    assert.match(output, /how the screen integrates the component rather than how the component renders/);
    assert.match(output, /No visual preview of the app\*\*[^\n]*never claim you inspected the app/);
    assert.match(output, /`window\.\*` globals/);
    assert.match(output, /states × themes × widths, at most 6/);
    assert.match(output, /`empty`, `error`, `loading` or long content/);
    assert.match(output, /`dark` next to `light` only if the theme changes the rendering/);
    assert.match(output, /mobile width[^\n]*only if the component is responsive/);
    assert.match(output, /each one-line caption says which of the two it shows/);

    const impeccable = await executor("impeccable", "polish settings", {} as never);
    assert.match(
      impeccable,
      /When `open_component_preview` is available, check the component's states, themes and widths there[^\n]*Use the app's preview for the requested workflow, navigation and the component's integration/,
    );
  } finally {
    service.stop();
  }
});
