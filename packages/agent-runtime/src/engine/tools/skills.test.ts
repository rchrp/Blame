import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blameNativeSkillsDirectory,
  conversationSkills,
  loadSkills,
  runSkill,
  skillDirectories,
  skillScopeSection,
  usableSkills,
  type Skill,
} from "./skills.js";
import { callThroughToolSet } from "./testing.js";

async function nativeSkills() {
  const skills = await loadSkills([blameNativeSkillsDirectory()]);
  return (name: string, args?: string) => runSkill(skills, name, args);
}

test("discovers and invokes Impeccable from Blame's own skills", async () => {
  const skills = await loadSkills([blameNativeSkillsDirectory()]);
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "blame-help",
    "component-preview",
    "impeccable",
  ]);
  const impeccable = skills.find((skill) => skill.name === "impeccable");
  assert.match(impeccable?.description ?? "", /frontend task/);
  assert.match(impeccable?.description ?? "", /Mandatory/);
  assert.match(impeccable?.description ?? "", /before making design/);
  const prompt = skillScopeSection(skills);
  assert.match(prompt, /"name":"impeccable"/);
  assert.match(prompt, /Not for backend-only/);
  assert.doesNotMatch(prompt, /# Impeccable for Blame/);

  const output = runSkill(skills, "impeccable", "polish settings");
  assert.match(output, /<command-name>impeccable<\/command-name>/);
  assert.match(output, /<command-args>polish settings<\/command-args>/);
  assert.match(output, /# Impeccable for Blame/);
  assert.match(output, /hard precondition/);
  assert.match(output, /consult_specialist/);
});

test("skill scope discovery omits disabled skills", () => {
  const skills: Skill[] = [
    {
      id: "enabled",
      name: "enabled",
      description: "Use for the requested API migration.",
      instructions: "A",
      file: "/a",
    },
    {
      id: "disabled",
      name: "disabled",
      description: "Do not expose",
      disabled: true,
      instructions: "B",
      file: "/b",
    },
  ];
  const prompt = skillScopeSection(skills);
  assert.match(prompt, /requested API migration/);
  assert.doesNotMatch(prompt, /disabled|Do not expose/);
  assert.equal(skillScopeSection([]), "");
  assert.match(runSkill(skills, "disabled"), /configured but disabled/);
  assert.match(
    runSkill(skills, "missing"),
    /not found\. Available skills: enabled/,
  );
});

test("skill scope snapshot is bounded without truncating a descriptor into a false scope", () => {
  const prompt = skillScopeSection([
    {
      id: "first",
      name: "first",
      description: "Use only for deployment.",
      instructions: "A",
      file: "/a",
    },
    {
      id: "long",
      name: "long",
      description: "x".repeat(20_000) + " Never use for deployment.",
      instructions: "B",
      file: "/b",
    },
  ]);
  assert.match(prompt, /Use only for deployment/);
  assert.match(prompt, /skills tool remains available/);
  assert.doesNotMatch(prompt, /"name":"long"/);
  assert.ok(prompt.length < 17_000);
});

test("the user's own skill folders are found, and the workspace's win over their home's", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-skills-"));
  try {
    const workspace = join(root, "repo");
    const home = join(root, "home");
    const write = async (folder: string, name: string, body: string) => {
      await mkdir(join(folder, name), { recursive: true });
      await writeFile(
        join(folder, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${name}\n\n${body} instructions.\n`,
      );
    };
    await write(
      join(workspace, ".claude", "skills"),
      "release",
      "Workspace release",
    );
    await write(join(home, ".agents", "skills"), "release", "Home release");
    await write(join(home, ".agents", "skills"), "review", "Home review");
    await write(
      join(workspace, ".clinerules", "skills"),
      "legacy",
      "A project that also uses Cline",
    );
    const directories = skillDirectories({
      workspaceRoot: workspace,
      home,
      builtIn: true,
    });
    const skills = await loadSkills(directories);
    assert.deepEqual(skills.map((skill) => skill.name).sort(), [
      "blame-help",
      "component-preview",
      "impeccable",
      "legacy",
      "release",
      "review",
    ]);
    assert.match(runSkill(skills, "Release"), /Workspace release instructions/);

    // The tool reads the folders when called, and its description stays put.
    const conversation = await conversationSkills(
      { workspaceRoot: workspace, home },
      ["finish_task"],
    );
    assert.ok(conversation.tool);
    assert.match(
      conversation.tool.description,
      /Available skills: legacy, release, review\./,
    );
    await writeFile(
      join(workspace, ".claude", "skills", "release", "SKILL.md"),
      "---\nname: release\n---\nShip it now.\n",
    );
    const result = await callThroughToolSet([conversation.tool], "skills", {
      skill: "/release",
      args: "v2",
    });
    assert.equal(result.outcome, "completed");
    assert.match(
      JSON.stringify(result.content),
      /<command-args>v2<\/command-args>/,
    );
    assert.match(JSON.stringify(result.content), /Ship it now\./);
    assert.match(
      conversation.tool.description,
      /Available skills: legacy, release, review\./,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the component preview skill is listed only with its tool", async () => {
  const skills = await loadSkills([blameNativeSkillsDirectory()]);
  const withTool = skillScopeSection(
    usableSkills(skills, ["finish_task", "open_component_preview"]),
  );
  assert.match(withTool, /"name":"component-preview"/);
  assert.match(
    withTool,
    /after creating a UI component or changing how one renders/,
  );
  assert.match(withTool, /even when the app's preview is available/);
  assert.match(withTool, /"name":"impeccable"/);
  for (const toolNames of [[], ["finish_task", "get_preview_devtools"]]) {
    const withoutTool = skillScopeSection(usableSkills(skills, toolNames));
    assert.match(withoutTool, /"name":"impeccable"/);
    assert.doesNotMatch(
      withoutTool,
      /component-preview|open_component_preview/,
    );
  }
});

test("the component preview skill explains the preview file and the tool", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "settings panel");
    assert.match(output, /<name>\.blame-preview\.tsx/);
    assert.match(output, /mount\(element, state\)/);
    assert.doesNotMatch(output, /\.blame-preview\.html|app\/blame-preview\//);
    assert.match(output, /open_component_preview/);
    assert.match(output, /take_snapshot/);
    assert.match(output, /finish_task/);
    assert.match(output, /Never change the project's real source/);
  }
});

test("the component preview skill covers Next.js and React packages without Vite", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "pricing card");
    assert.doesNotMatch(output, /have no component preview/);
    assert.match(output, /Blame's own Vite with `@vitejs\/plugin-react`/);
    assert.match(
      output,
      /PostCSS or Tailwind config and the `paths` of its `tsconfig\.json` \(or `jsconfig\.json`\) apply/,
    );
    assert.match(
      output,
      /`next\/link`, `next\/image`, `next\/navigation` and `next\/font\/\*` are small shims, in this server only/,
    );
    assert.match(output, /`"use client"` files render as they are/);
    assert.match(
      output,
      /Only client components render\. A Server Component[^\n]*preview its client sub-components with the props it would pass them, or check that screen in the app/,
    );
  }
});

test("the component preview skill shows how to mount a Vue 3 component without Vite", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "profile card");
    assert.match(
      output,
      /Vue 3 package \(`vue` 3\.2\.25 or later\) without `vite\.config\.\*`[^\n]*Blame's own Vite with `@vitejs\/plugin-vue`/,
    );
    assert.match(
      output,
      /import ProfileCard from "@\/components\/ProfileCard\.vue"/,
    );
    assert.match(
      output,
      /export function mount\(element: HTMLElement, state: string\) \{\n {2}createApp\(ProfileCard, states\[state\]\)\.mount\(element\)\n\}/,
    );
    assert.match(output, /`<style>` and `<style scoped>` blocks apply/);
    assert.match(output, /In a Vue CLI package, `@\/` resolves to `src\/`/);
    assert.match(output, /Vue 2 is not supported/);
  }
});

test("the component preview skill shows how to mount a Svelte component, in a SvelteKit app or without Vite", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "profile card");
    assert.match(output, /import \{ mount as mountComponent \} from "svelte"/);
    assert.match(
      output,
      /import ProfileCard from "\$lib\/components\/ProfileCard\.svelte"/,
    );
    assert.match(
      output,
      /export function mount\(element: HTMLElement, state: string\) \{\n {2}mountComponent\(ProfileCard, \{ target: element, props: states\[state\] \}\)\n\}/,
    );
    assert.match(
      output,
      /A SvelteKit app keeps its own Vite and `sveltekit\(\)`/,
    );
    assert.match(output, /`\$app\/state`[^\n]*a page at `\/`/);
    assert.match(
      output,
      /Svelte 5 package \(`svelte` 5\.46\.4 or later\) without `vite\.config\.\*`[^\n]*Blame's own Vite with `@sveltejs\/vite-plugin-svelte`/,
    );
    assert.match(output, /Svelte 4 is not supported/);
  }
});

test("the component preview skill covers React Native packages with react-native-web, such as an Expo app", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "profile card");
    assert.match(
      output,
      /React Native package with `react-native-web`, such as an Expo app with web support,[^\n]*Blame's own Vite with `@vitejs\/plugin-react`/,
    );
    assert.match(
      output,
      /`react-native` resolves to `react-native-web`, a `\.web\.tsx` or `\.web\.ts` file comes before its native variant, `__DEV__` is `true`/,
    );
    assert.match(
      output,
      /import \{ ProfileCard \} from "\.\/components\/profile-card"\n\nexport default <ProfileCard name="Ada Lovelace" status="Active" \/>/,
    );
    assert.match(
      output,
      /Without `react-native-web`, the package is not rendered[^\n]*in the app or on a device/,
    );
    assert.match(
      output,
      /An Expo module without a web implementation[^\n]*fails with an error that names it/,
    );
  }
});

test("the component preview skill shows how to mount an Angular component without Vite", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "profile card");
    assert.match(
      output,
      /Vite, React, Vue 3, Svelte 5 or Angular project \(Next\.js, Vue CLI, Nuxt, SvelteKit and Angular CLI included\)/,
    );
    assert.match(
      output,
      /An Angular 17 to 22 package without `vite\.config\.\*`, with `@angular\/build` or `@angular-devkit\/build-angular`[^\n]*Blame's own Vite with `@analogjs\/vite-plugin-angular`[^\n]*the project's own Angular compiler/,
    );
    assert.match(
      output,
      /import "\.\.\/\.\.\/styles\.css" \/\/ each stylesheet of "styles" in angular\.json/,
    );
    assert.match(
      output,
      /export async function mount\(element: HTMLElement, state: string\) \{\n {2}const app = await createApplication\(\{ providers: \[provideRouter\(\[\]\)\] \}\)\n {2}const card = createComponent\(ProfileCardComponent, \{ environmentInjector: app\.injector, hostElement: element \}\)\n {2}for \(const \[name, value\] of Object\.entries\(states\[state\]\)\) card\.setInput\(name, value\)\n {2}app\.attachView\(card\.hostView\)\n {2}card\.changeDetectorRef\.detectChanges\(\)\n\}/,
    );
    assert.match(
      output,
      /`provideRouter\(\[\]\)` for a component that uses `routerLink`, `RouterOutlet`, `Router` or `ActivatedRoute`/,
    );
    assert.match(
      output,
      /zone\.js loads before the preview file when the `polyfills` of `angular\.json` include it[^\n]*Otherwise the render is zoneless/,
    );
    assert.match(output, /`provideZonelessChangeDetection\(\)`/);
    assert.match(
      output,
      /A component an NgModule declares \(`standalone: false`\): import that module's file, add `importProvidersFrom\(TheModule\)` to the providers/,
    );
    assert.match(
      output,
      /Angular 16 and earlier are not supported, nor server-side rendering/,
    );
  }
});

test("the component preview skill shows how to preview a Nuxt component", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "order summary");
    assert.match(output, /## Nuxt 3 and 4/);
    assert.match(
      output,
      /import "~\/assets\/css\/main\.css" \/\/ the stylesheets of nuxt\.config's css field/,
    );
    assert.match(
      output,
      /import OrderSummary from "~\/components\/OrderSummary\.vue"/,
    );
    assert.match(output, /`components\/base\/Button\.vue` is `<BaseButton>`/);
    assert.match(
      output,
      /`~\/` and `@\/` resolve to the `srcDir` \(`app\/` in Nuxt 4\)/,
    );
    assert.match(
      output,
      /`useRuntimeConfig\(\)` returns the `public` part of `runtimeConfig` in `nuxt\.config`/,
    );
    assert.match(
      output,
      /`useFetch`, `useAsyncData`, `\$fetch` and imports of `server\/` fail with a clear message[^\n]*pass made-up data/,
    );
    assert.match(output, /Nuxt 2 is not supported/);
  }
});

test("the component preview skill makes the component preview the default visual check", async () => {
  {
    const executor = await nativeSkills();
    const output = executor("component-preview", "settings panel");
    assert.doesNotMatch(output, /Prefer the real app/);
    assert.match(
      output,
      /Component preview first\*\*, even when the app's preview is available/,
    );
    assert.match(output, /App captures as a complement/);
    assert.match(
      output,
      /a whole screen, a flow, where the component sits in its page, navigation between screens/,
    );
    assert.match(
      output,
      /The app alone only when the component preview costs more than the app/,
    );
    assert.match(
      output,
      /heavy fakes \(several providers, global state, real data\)/,
    );
    assert.match(
      output,
      /how the screen integrates the component rather than how the component renders/,
    );
    assert.match(
      output,
      /No visual preview of the app\*\*[^\n]*never claim you inspected the app/,
    );
    assert.match(output, /`window\.\*` globals/);
    assert.match(output, /states × themes × widths, at most 6/);
    assert.match(output, /`empty`, `error`, `loading` or long content/);
    assert.match(
      output,
      /`dark` next to `light` only if the theme changes the rendering/,
    );
    assert.match(
      output,
      /mobile width[^\n]*only if the component is responsive/,
    );
    assert.match(
      output,
      /each one-line caption says which of the two it shows/,
    );

    const impeccable = executor("impeccable", "polish settings");
    assert.match(
      impeccable,
      /When `open_component_preview` is available, check the component's states, themes and widths there[^\n]*Use the app's preview for the requested workflow, navigation and the component's integration/,
    );
  }
});
