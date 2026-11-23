import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blameNativeSkillsDirectory,
  conversationSkills,
  loadSkills,
  pickerSkills,
  runSkill,
  skillDirectories,
  skillInstructions,
  skillScopeSection,
  usableSkills,
  userInvocableSkills,
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

async function withFolders(
  files: Record<string, string>,
  check: (folders: { workspace: string; home: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-skills-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
    }
    await check({ workspace: join(root, "repo"), home: join(root, "home") });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function loaded(folders: { workspace: string; home: string }) {
  return loadSkills(
    skillDirectories({ workspaceRoot: folders.workspace, home: folders.home }),
  );
}

test("Claude's own folders are read: the project's skills beat the user's, and a skill beats a command", async () => {
  await withFolders(
    {
      "home/.claude/skills/deploy/SKILL.md":
        "---\nname: deploy\ndescription: Home deploy\n---\nHome deploy body.\n",
      "home/.claude/skills/notes/SKILL.md":
        "---\ndescription: Home notes\n---\nTake notes.\n",
      "home/.agents/skills/agents-only/SKILL.md":
        "---\ndescription: Agents folder\n---\nBody.\n",
      "home/.claude/commands/notes.md": "Home command notes.\n",
      "home/.claude/commands/ship.md": "Home ship command.\n",
      "repo/.claude/skills/deploy/SKILL.md":
        "---\nname: deploy\ndescription: Project deploy\n---\nProject deploy body.\n",
      "repo/.claude/commands/ship.md":
        "---\ndescription: Ship it\nargument-hint: [env]\n---\nShip to $ARGUMENTS.\n",
      "repo/.claude/commands/frontend/component.md":
        "Build a component named $0.\n",
    },
    async (folders) => {
      const skills = await loaded(folders);
      const byId = new Map(skills.map((skill) => [skill.id, skill]));
      assert.deepEqual([...byId.keys()].sort(), [
        "agents-only",
        "deploy",
        "frontend:component",
        "notes",
        "ship",
      ]);
      assert.match(byId.get("deploy")!.instructions, /^Project deploy/);
      // The home's folder and command of one name: the folder.
      assert.equal(byId.get("notes")!.command, undefined);
      assert.match(byId.get("notes")!.instructions, /Take notes/);
      // The project's command beats the user's of the same name.
      assert.match(byId.get("ship")!.instructions, /^Ship to/);
      assert.equal(byId.get("ship")!.command, true);
      assert.equal(byId.get("ship")!.argumentHint, "[env]");
      // A command without a description describes itself by its first line.
      assert.equal(
        byId.get("frontend:component")!.description,
        "Build a component named $0.",
      );
      assert.match(
        runSkill(skills, "frontend:component", "Card"),
        /Build a component named Card\./,
      );
    },
  );
});

test("a skill folder beats a command of the same name inside one scope", async () => {
  await withFolders(
    {
      "repo/.claude/skills/review/SKILL.md": "---\nname: review\n---\nSkill.\n",
      "repo/.claude/commands/review.md": "Command.\n",
    },
    async (folders) => {
      const skills = await loaded(folders);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.instructions, "Skill.");
    },
  );
});

test("front matter the loader does not know, or cannot parse, never drops a skill", async () => {
  await withFolders(
    {
      "repo/.claude/skills/odd/SKILL.md":
        "---\nname: odd\ndescription: Use when: the user says odd\nallowed-tools: Bash(git *)\ncontext: fork\nhooks:\n  PreToolUse: []\nmodel: haiku\npaths: src/**\nfuture-key: 1\n---\nOdd body.\n",
      "repo/.claude/skills/folded/SKILL.md":
        "---\ndescription: >\n  Folded text\n  over lines\nwhen_to_use: When asked.\n---\nFolded body.\n",
      "repo/.claude/skills/no-front-matter/SKILL.md":
        "# Plain title\n\nJust text.\n",
      "repo/.claude/skills/empty-front-matter/SKILL.md": "---\n---\nBody.\n",
      "repo/.claude/skills/late-marker/SKILL.md":
        "\n---\nname: ignored\n---\nBody.\n",
      "repo/.claude/skills/bad-name/SKILL.md":
        '---\nname: "bad<name>"\n---\nBody.\n',
    },
    async (folders) => {
      const skills = await loaded(folders);
      const byId = new Map(skills.map((skill) => [skill.id, skill]));
      assert.deepEqual([...byId.keys()].sort(), [
        "bad-name",
        "empty-front-matter",
        "folded",
        "late-marker",
        "no-front-matter",
        "odd",
      ]);
      // The YAML did not parse (a colon in a plain scalar): the lines did.
      assert.equal(byId.get("odd")!.description, "Use when: the user says odd");
      assert.equal(byId.get("odd")!.instructions, "Odd body.");
      assert.equal(
        byId.get("folded")!.description,
        "Folded text over lines When asked.",
      );
      assert.equal(byId.get("no-front-matter")!.description, "Plain title");
      assert.equal(byId.get("empty-front-matter")!.instructions, "Body.");
      assert.equal(byId.get("late-marker")!.name, "late-marker");
    },
  );
});

test("a skill only the user may run is not shown to the model but runs by name", async () => {
  await withFolders(
    {
      "repo/.claude/skills/deploy/SKILL.md":
        "---\ndescription: Deploy to production\ndisable-model-invocation: true\nargument-hint: [environment]\n---\nDeploy $0 now.\n",
      "repo/.claude/skills/background/SKILL.md":
        "---\ndescription: How the legacy billing works\nuser-invocable: false\n---\nBilling facts.\n",
      "repo/.claude/skills/lint/SKILL.md":
        "---\ndescription: Lint the code\ndisable-model-invocation: Yes\n---\nLint.\n",
      "repo/.claude/skills/normal/SKILL.md":
        "---\ndescription: Normal skill\nuser-invocable: true\ndisable-model-invocation: false\n---\nNormal.\n",
    },
    async (folders) => {
      const conversation = await conversationSkills(
        { workspaceRoot: folders.workspace, home: folders.home },
        [],
      );
      // Not in the prompt, not in the tool's description.
      assert.doesNotMatch(
        conversation.prompt,
        /Deploy to production|Lint the code/,
      );
      assert.match(conversation.prompt, /legacy billing/);
      assert.match(conversation.prompt, /Normal skill/);
      assert.ok(conversation.tool);
      assert.match(
        conversation.tool.description,
        /Available skills: background, normal\.$/,
      );
      // The user's picker: everything but the model's own.
      assert.deepEqual(
        userInvocableSkills(conversation.skills)
          .map((skill) => skill.id)
          .sort(),
        ["deploy", "lint", "normal"],
      );
      // Still run when asked for by name.
      const result = await callThroughToolSet([conversation.tool], "skills", {
        skill: "deploy",
        args: "staging",
      });
      assert.match(JSON.stringify(result.content), /Deploy staging now\./);
      // And the model is not told they exist when it asks for a wrong name.
      assert.doesNotMatch(
        runSkill(conversation.skills, "missing"),
        /deploy|lint/,
      );
    },
  );
});

test("the tool exists when every skill is the user's to run", async () => {
  await withFolders(
    {
      "repo/.claude/skills/deploy/SKILL.md":
        "---\ndescription: Deploy\ndisable-model-invocation: true\n---\nDeploy.\n",
    },
    async (folders) => {
      const conversation = await conversationSkills(
        { workspaceRoot: folders.workspace, home: folders.home },
        [],
      );
      // The prompt only says how a `/name` is run, and names nothing.
      assert.match(conversation.prompt, /when the user writes `\/name`/);
      assert.doesNotMatch(conversation.prompt, /Deploy/);
      assert.ok(conversation.tool);
      assert.doesNotMatch(conversation.tool.description, /Available skills/);
    },
  );
});

function skill(instructions: string, extra: Partial<Skill> = {}): Skill {
  return {
    id: "s",
    name: "s",
    instructions,
    file: "/skills/s/SKILL.md",
    ...extra,
  };
}

test("arguments are substituted as Claude Code does", () => {
  assert.equal(
    skillInstructions(skill("Fix $ARGUMENTS now."), "issue 12  fast"),
    "Fix issue 12  fast now.",
  );
  assert.equal(
    skillInstructions(skill("From $0 to $1, then $ARGUMENTS[0]."), "a b"),
    "From a to b, then a.",
  );
  assert.equal(
    skillInstructions(skill("Move $0 to $1."), '"hello world" second'),
    "Move hello world to second.",
  );
  assert.equal(
    skillInstructions(skill("Move $0 to $1."), "'it is' two"),
    "Move it is to two.",
  );
  // An indexed argument nobody gave stays as written; a named one is empty.
  assert.equal(skillInstructions(skill("A $0, B $2."), "x"), "A x, B $2.");
  assert.equal(
    skillInstructions(
      skill("In $env on $branch.", { argumentNames: ["env", "branch"] }),
      "prod",
    ),
    "In prod on .",
  );
  // An undeclared name is plain text.
  assert.equal(
    skillInstructions(skill("Cost: $price"), "x"),
    "Cost: $price\n\nARGUMENTS: x",
  );
  // Escapes, and values read once.
  assert.equal(
    skillInstructions(skill("Costs \\$1.00; ask $0."), "$1"),
    "Costs $1.00; ask $1.",
  );
  assert.equal(skillInstructions(skill("\\\\$0"), "x"), "\\\\x");
  assert.equal(
    skillInstructions(skill("$ARGUMENTS"), "$ARGUMENTS"),
    "$ARGUMENTS",
  );
  assert.equal(
    skillInstructions(skill("Cost is \\$USD."), "x"),
    "Cost is \\$USD.\n\nARGUMENTS: x",
  );
  // No placeholder: the arguments follow the instructions.
  assert.equal(
    skillInstructions(skill("Do the thing."), "now please"),
    "Do the thing.\n\nARGUMENTS: now please",
  );
  assert.equal(
    skillInstructions(skill("Do the thing."), "  "),
    "Do the thing.",
  );
  assert.equal(skillInstructions(skill("Do the thing.")), "Do the thing.");
  // No arguments: the placeholders stay for an indexed one, vanish otherwise.
  assert.equal(skillInstructions(skill("Run $ARGUMENTS."), ""), "Run .");
  // The skill's folder.
  assert.equal(
    skillInstructions(skill("Run ${CLAUDE_SKILL_DIR}/scripts/x.sh"), undefined),
    "Run /skills/s/scripts/x.sh",
  );
});

// A skill shaped like Anthropic's published `pdf` skill (written here, not
// copied): front matter with a license, a body naming `forms.md`,
// `reference.md` and scripts, and a LICENSE.txt.
const pdfSkill = `---
name: pdf
description: Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

Read [forms.md](forms.md) to fill a form and [references/reference.md](references/reference.md) for the API.

Check the fields first:

\`\`\`bash
python \${CLAUDE_SKILL_DIR}/scripts/check_fillable_fields.py <file.pdf>
\`\`\`
`;

test("a skill with references and scripts hands its folder to the model and reads only inside it", async () => {
  await withFolders(
    {
      "home/.claude/skills/pdf/SKILL.md": pdfSkill,
      "home/.claude/skills/pdf/LICENSE.txt": "Terms.\n",
      "home/.claude/skills/pdf/forms.md": "# Forms\n\nFill them.\n",
      "home/.claude/skills/pdf/references/reference.md": "R".repeat(50_000),
      "home/.claude/skills/pdf/scripts/check_fillable_fields.py":
        "print('fields')\n",
      "home/.claude/skills/pdf/assets/blank.bin": "\u0000\u0001binary",
      "home/.claude/skills/notes/SKILL.md": "---\nname: notes\n---\nNotes.\n",
      "home/secret.md": "Do not read.\n",
      "outside/shared.md": "Shared outside.\n",
      "repo/.claude/commands/ship.md": "Ship.\n",
    },
    async (folders) => {
      const { symlink } = await import("node:fs/promises");
      const pdf = join(folders.home, ".claude", "skills", "pdf");
      await symlink(
        join(folders.home, "secret.md"),
        join(pdf, "references", "leak.md"),
      );
      await symlink(
        join(folders.home, "..", "outside"),
        join(pdf, "linked-folder"),
      );
      await symlink(
        join(pdf, "forms.md"),
        join(pdf, "references", "forms-alias.md"),
      );
      const conversation = await conversationSkills(
        { workspaceRoot: folders.workspace, home: folders.home },
        [],
      );
      assert.ok(conversation.tool);
      const call = async (input: Record<string, unknown>) =>
        JSON.stringify(
          (await callThroughToolSet([conversation.tool!], "skills", input))
            .content,
        );

      const run = await call({ skill: "pdf", args: "report.pdf" });
      assert.match(run, new RegExp(`Base directory for this skill: ${pdf}`));
      // The scripts' real location is in the instructions, and the arguments
      // follow them as the body has no placeholder.
      assert.match(run, new RegExp(`python ${pdf}/scripts/check_fillable`));
      assert.match(run, /ARGUMENTS: report\.pdf/);
      // A skill with no extra file does not carry the line.
      assert.doesNotMatch(await call({ skill: "notes" }), /Base directory/);

      assert.match(
        await call({ skill: "pdf", file: "forms.md" }),
        /Fill them\./,
      );
      assert.match(
        await call({ skill: "pdf", file: "scripts/check_fillable_fields.py" }),
        /print\('fields'\)/,
      );
      // By its absolute path too, and through a link that stays inside.
      assert.match(
        await call({ skill: "pdf", file: join(pdf, "forms.md") }),
        /Fill them\./,
      );
      assert.match(
        await call({ skill: "pdf", file: "references/forms-alias.md" }),
        /Fill them\./,
      );

      // Long files come a page at a time.
      const page = await call({
        skill: "pdf",
        file: "references/reference.md",
      });
      assert.match(page, /continue with offset 40000/);
      const rest = await call({
        skill: "pdf",
        file: "references/reference.md",
        offset: 40_000,
      });
      assert.doesNotMatch(rest, /continue with offset/);

      // Nothing outside the skill's folder, however it is spelled.
      for (const file of [
        "../notes/SKILL.md",
        "../../secret.md",
        join(folders.home, "secret.md"),
        "/etc/hosts",
        "references/leak.md",
        "linked-folder/shared.md",
      ])
        assert.match(
          await call({ skill: "pdf", file }),
          /Only files inside the skill's own folder|not found/,
          file,
        );
      assert.doesNotMatch(
        await call({ skill: "pdf", file: "../../secret.md" }),
        /Do not read/,
      );
      assert.match(await call({ skill: "pdf", file: "assets" }), /not a file/);
      assert.match(
        await call({ skill: "pdf", file: "assets/blank.bin" }),
        /binary file/,
      );
      assert.match(
        await call({ skill: "pdf", file: "missing.md" }),
        /not found/,
      );
      // A command is one file in a shared folder: it has no files to read.
      assert.match(
        await call({ skill: "ship", file: "../skills/x" }),
        /no files besides/,
      );
      // And only a skill of the conversation's snapshot is read.
      await mkdir(join(folders.home, ".claude", "skills", "late"), {
        recursive: true,
      });
      await writeFile(
        join(folders.home, ".claude", "skills", "late", "SKILL.md"),
        "---\nname: late\n---\nLate.\n",
      );
      assert.match(
        await call({ skill: "late", file: "SKILL.md" }),
        /not found/,
      );
    },
  );
});

test("the picker lists what the user may start with /name", async () => {
  await withFolders(
    {
      "home/.claude/skills/deploy/SKILL.md":
        "---\ndescription: Deploy\nargument-hint: [environment]\ndisable-model-invocation: true\n---\nDeploy.\n",
      "home/.claude/skills/background/SKILL.md":
        "---\ndescription: Facts\nuser-invocable: false\n---\nFacts.\n",
      "repo/.claude/commands/fix-issue.md":
        "---\ndescription: Fix a GitHub issue\nargument-hint: [issue-number]\n---\nFix $ARGUMENTS.\n",
    },
    async (folders) => {
      const items = await pickerSkills({
        workspaceRoot: folders.workspace,
        home: folders.home,
      });
      const names = items.map((item) => item.name);
      assert.deepEqual(names.slice(0, 2), ["deploy", "fix-issue"]);
      assert.ok(names.includes("impeccable"));
      assert.ok(!names.includes("background"));
      // Needs a tool the conversation may not have.
      assert.ok(!names.includes("component-preview"));
      assert.deepEqual(items[0], {
        name: "deploy",
        description: "Deploy",
        argumentHint: "[environment]",
      });
      assert.equal(items[1]!.argumentHint, "[issue-number]");
    },
  );
});
