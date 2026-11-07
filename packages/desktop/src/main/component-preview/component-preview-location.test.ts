import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  componentPreviewToolkitRoot,
  containerComponentPreviewHost,
  workspaceComponentPreviewHost,
} from "./component-preview-hosts.ts";
import {
  hasComponentPreviewProject,
  locateComponentPreview,
} from "./component-preview-location.ts";

type SpawnCall = { args: string[]; command: string; options: unknown };

// A child process that exits when it is told to.
function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = ((command: string, args: string[], options: unknown) => {
    calls.push({ args, command, options });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      },
      pid: undefined,
      signalCode: null,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    if (args[0] === "rm") queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  }) as never;
  return { calls, spawn };
}

test("the container host runs one more container of the preview service, with only the server's port", async () => {
  const { calls, spawn } = fakeSpawn();
  const host = containerComponentPreviewHost(
    {
      composeFile: "/w/.blame/preview/compose.yaml",
      projectName: "blame_abc",
      serviceId: "web",
      worktree: "/w",
    },
    spawn,
  );
  assert.equal(host.bindHost, "0.0.0.0");
  assert.equal(host.path("packages/app"), "/workspace/packages/app");
  assert.equal(host.path(""), "/workspace");
  const server = host.start(["--input-type=module", "-e", "code"], 45123);
  const [run] = calls;
  assert.equal(run!.command, "docker");
  const name = run!.args[run!.args.indexOf("--name") + 1]!;
  assert.match(name, /^blame_abc-component-preview-[0-9a-f]{8}$/u);
  assert.deepEqual(run!.args, [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    "blame_abc",
    "--file",
    "/w/.blame/preview/compose.yaml",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--name",
    name,
    "--publish",
    "127.0.0.1:45123:45123",
    "--entrypoint",
    "node",
    "web",
    "--input-type=module",
    "-e",
    "code",
  ]);
  assert.deepEqual(run!.options, { execution: "virtualized", user: "root" });
  await server.stop();
  // The container goes with the process, even if Docker kept it.
  assert.deepEqual(calls[1]!.args, ["rm", "-f", name]);
});

test("a container that runs Blame's own Vite mounts its folder at the same path", async () => {
  const { calls, spawn } = fakeSpawn();
  const host = containerComponentPreviewHost(
    {
      composeFile: "/w/.blame/preview/compose.yaml",
      projectName: "blame_abc",
      serviceId: "web",
      toolkitRoot: "/home/blame/.local/share/blame/runtime/component-preview",
      worktree: "/w",
    },
    spawn,
  );
  assert.equal(
    host.toolkitRoot,
    "/home/blame/.local/share/blame/runtime/component-preview",
  );
  const server = host.start(["-e", "code"], 45123);
  const args = calls[0]!.args;
  assert.deepEqual(args.slice(args.indexOf("--publish"), args.indexOf("web")), [
    "--publish",
    "127.0.0.1:45123:45123",
    "--volume",
    "/home/blame/.local/share/blame/runtime/component-preview:/home/blame/.local/share/blame/runtime/component-preview",
    "--entrypoint",
    "node",
  ]);
  await server.stop();
});

test("Blame's own Vite lives outside every worktree: beside the runtime's worktrees, or in the user's cache", () => {
  assert.equal(
    componentPreviewToolkitRoot(
      "/home/blame/.local/share/blame/runtime/worktrees/app/story-1",
      "darwin",
    ),
    "/home/blame/.local/share/blame/runtime/component-preview",
  );
  assert.equal(
    componentPreviewToolkitRoot(
      "/home/blame/.local/share/blame/runtime/worktrees/app/story-1",
      "win32",
    ),
    "/home/blame/.local/share/blame/runtime/component-preview",
  );
  // A project folder, on this computer.
  assert.equal(
    componentPreviewToolkitRoot("/Users/ada/code/app", "darwin"),
    join(homedir(), ".cache", "blame", "component-preview"),
  );
  assert.equal(
    componentPreviewToolkitRoot("/home/ada/code/app", "linux"),
    join(homedir(), ".cache", "blame", "component-preview"),
  );
});

test("the workspace host runs Node in the worktree, where run_task runs", async () => {
  const { calls, spawn } = fakeSpawn();
  const host = workspaceComponentPreviewHost("/w", spawn, "/cache/preview");
  assert.equal(host.bindHost, "127.0.0.1");
  assert.equal(host.path(""), "/w");
  assert.equal(host.path("packages/app"), join("/w", "packages", "app"));
  assert.equal(host.toolkitRoot, "/cache/preview");
  const server = host.start(["-e", "code"], 45123);
  assert.deepEqual(calls[0], {
    args: ["-e", "code"],
    command: "node",
    options: { cwd: "/w" },
  });
  await server.stop();
  await server.exited;
});

test("a preview file is located in its Vite package, with Vite installed in the workspace", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-locate-"));
  try {
    const app = join(worktree, "packages/app");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(worktree, "packages/web/src"), { recursive: true });
    await writeFile(join(worktree, "package.json"), "{}");
    await writeFile(join(app, "package.json"), "{}");
    await writeFile(join(worktree, "packages/web/package.json"), "{}");
    await writeFile(join(app, "src/card.blame-preview.tsx"), "");
    await writeFile(join(worktree, "packages/web/src/x.blame-preview.tsx"), "");
    const locate = (
      file: string,
      workspaceMode: "direct" | "local-container" = "direct",
    ) => locateComponentPreview({ workspaceMode, worktree }, file);

    assert.match(
      (
        (await locate("packages/app/src/missing.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /does not exist/u,
    );
    assert.match(
      (
        (await locate("packages/web/src/x.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /^packages\/web has no vite\.config\.\* file and does not depend on React or Vue 3/u,
    );
    await writeFile(join(app, "vite.config.ts"), "export default {}");
    assert.match(
      (
        (await locate("packages/app/src/card.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /^Vite is not installed for packages\/app in the story's workspace\. open_component_preview never installs the project's dependencies/u,
    );
    // Hoisted to the root, as npm and pnpm workspaces may do.
    await mkdir(join(worktree, "node_modules/vite"), { recursive: true });
    await writeFile(join(worktree, "node_modules/vite/package.json"), "{}");
    const located = await locate("packages/app/src/card.blame-preview.tsx");
    assert.ok("host" in located);
    assert.equal(located.packageDir, "packages/app");
    assert.equal(located.host.key, `workspace:${worktree}`);
    // Its own Vite, even when it also depends on React.
    assert.equal(located.toolkit, undefined);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a React package without Vite, such as a Next.js app, is served by Blame's own Vite", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-react-"));
  try {
    const web = join(worktree, "apps/web");
    const admin = join(worktree, "apps/admin");
    await mkdir(join(web, "components"), { recursive: true });
    await mkdir(join(admin, "src"), { recursive: true });
    await writeFile(
      join(worktree, "package.json"),
      '{ "private": true, "devDependencies": { "react": "19.0.0" } }',
    );
    await writeFile(
      join(web, "package.json"),
      '{ "dependencies": { "next": "16.0.0", "react": "19.0.0", "react-dom": "19.0.0" } }',
    );
    // A webpack app of the same workspace: React comes from the root.
    await writeFile(join(admin, "package.json"), '{ "scripts": {} }');
    await writeFile(join(web, "components/card.blame-preview.tsx"), "");
    await writeFile(join(admin, "src/table.blame-preview.tsx"), "");
    const locate = (file: string, workspaceMode: "direct" = "direct") =>
      locateComponentPreview({ workspaceMode, worktree }, file);

    assert.match(
      (
        (await locate("apps/web/components/card.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /^React is not installed for apps\/web in the story's workspace\. open_component_preview never installs the project's dependencies/u,
    );
    for (const name of ["react", "react-dom"]) {
      await mkdir(join(worktree, "node_modules", name), { recursive: true });
      await writeFile(
        join(worktree, "node_modules", name, "package.json"),
        "{}",
      );
    }
    const next = await locate("apps/web/components/card.blame-preview.tsx");
    assert.ok("host" in next, JSON.stringify(next));
    assert.equal(next.packageDir, "apps/web");
    assert.deepEqual(next.toolkit, { framework: "next" });
    assert.equal(
      next.host.toolkitRoot,
      join(homedir(), ".cache", "blame", "component-preview"),
    );
    const react = await locate("apps/admin/src/table.blame-preview.tsx");
    assert.ok("host" in react, JSON.stringify(react));
    assert.deepEqual(react.toolkit, { framework: "react" });
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("only a project with a Vite config or a React package gets the tool", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-vite-"));
  try {
    await mkdir(join(worktree, "node_modules/pkg"), { recursive: true });
    await writeFile(join(worktree, "node_modules/pkg/vite.config.js"), "");
    await writeFile(
      join(worktree, "node_modules/pkg/package.json"),
      '{ "dependencies": { "react": "19.0.0" } }',
    );
    // An Angular app.
    await writeFile(
      join(worktree, "package.json"),
      '{ "dependencies": { "@angular/core": "20.0.0" } }',
    );
    await writeFile(join(worktree, "angular.json"), "{}");
    assert.equal(await hasComponentPreviewProject(worktree), false);
    await mkdir(join(worktree, "apps/site"), { recursive: true });
    await writeFile(join(worktree, "apps/site/package.json"), "not json");
    assert.equal(await hasComponentPreviewProject(worktree), false);
    await writeFile(
      join(worktree, "apps/site/package.json"),
      '{ "dependencies": { "next": "16.0.0" } }',
    );
    assert.equal(await hasComponentPreviewProject(worktree), true);
    await rm(join(worktree, "apps"), { force: true, recursive: true });
    await mkdir(join(worktree, "packages/app"), { recursive: true });
    await writeFile(join(worktree, "packages/app/vite.config.ts"), "");
    assert.equal(await hasComponentPreviewProject(worktree), true);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a Vue 3 package without Vite, such as a Vue CLI app, is served by Blame's own Vite; a Vue 2 package is told it is not supported", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-vue-"));
  try {
    const shop = join(worktree, "apps/shop");
    const legacy = join(worktree, "apps/legacy");
    await mkdir(join(shop, "src"), { recursive: true });
    await mkdir(join(legacy, "src"), { recursive: true });
    // React at the root, for the workspace's tooling: each package's own
    // framework wins.
    await writeFile(
      join(worktree, "package.json"),
      '{ "private": true, "devDependencies": { "react": "19.0.0" } }',
    );
    await writeFile(
      join(shop, "package.json"),
      '{ "dependencies": { "vue": "^3.5.0" }, "devDependencies": { "@vue/cli-service": "~5.0.8" } }',
    );
    await writeFile(
      join(legacy, "package.json"),
      '{ "dependencies": { "vue": "^2.7.16" } }',
    );
    await writeFile(join(shop, "src/card.blame-preview.ts"), "");
    await writeFile(join(legacy, "src/card.blame-preview.ts"), "");
    const locate = (file: string) =>
      locateComponentPreview({ workspaceMode: "direct", worktree }, file);

    assert.match(
      (
        (await locate("apps/shop/src/card.blame-preview.ts")) as {
          message: string;
        }
      ).message,
      /^Vue is not installed for apps\/shop in the story's workspace\. open_component_preview never installs the project's dependencies/u,
    );
    await mkdir(join(worktree, "node_modules/vue"), { recursive: true });
    await writeFile(join(worktree, "node_modules/vue/package.json"), "{}");
    const shopLocation = await locate("apps/shop/src/card.blame-preview.ts");
    assert.ok("host" in shopLocation, JSON.stringify(shopLocation));
    assert.equal(shopLocation.packageDir, "apps/shop");
    assert.deepEqual(shopLocation.toolkit, { framework: "vue" });

    // Installed or not, Vue 2 gets a clear message, never a compiler error.
    assert.match(
      (
        (await locate("apps/legacy/src/card.blame-preview.ts")) as {
          message: string;
        }
      ).message,
      /^Vue 2 is not supported: apps\/legacy depends on Vue 2 and has no vite\.config\.\* file\. Without one, open_component_preview renders React components and Vue 3 components \(vue 3\.2\.25 or later\) only\./u,
    );
    // With its own Vite config, a Vue 2 package uses its own Vite.
    await writeFile(join(legacy, "vite.config.js"), "export default {}");
    await mkdir(join(worktree, "node_modules/vite"), { recursive: true });
    await writeFile(join(worktree, "node_modules/vite/package.json"), "{}");
    const legacyLocation = await locate(
      "apps/legacy/src/card.blame-preview.ts",
    );
    assert.ok("host" in legacyLocation, JSON.stringify(legacyLocation));
    assert.equal(legacyLocation.toolkit, undefined);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a Vue 3 project gets the tool, a Vue 2 project does not", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-vue-project-"));
  const offered = async (vue: string) => {
    await writeFile(
      join(worktree, "package.json"),
      JSON.stringify({ dependencies: { vue } }),
    );
    return hasComponentPreviewProject(worktree);
  };
  try {
    assert.equal(await offered("^2.7.16"), false);
    assert.equal(await offered("~2.6.14"), false);
    assert.equal(await offered("2.x"), false);
    assert.equal(await offered("^3.2.25"), true);
    assert.equal(await offered("3.5.45"), true);
    // A library that supports both.
    assert.equal(await offered("^2.7.0 || ^3.0.0"), true);
    // Ranges it cannot read count as Vue 3: the server checks what is
    // installed.
    assert.equal(await offered("latest"), true);
    assert.equal(await offered("catalog:"), true);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a Nuxt 3 or 4 package is served by Blame's own Vite with Nuxt's shims; a Nuxt 2 package is told it is not supported", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-nuxt-"));
  try {
    const shop = join(worktree, "apps/shop");
    const legacy = join(worktree, "apps/legacy");
    const ui = join(worktree, "packages/ui");
    await mkdir(join(shop, "app/components"), { recursive: true });
    await mkdir(join(legacy, "components"), { recursive: true });
    await mkdir(join(ui, "src"), { recursive: true });
    // Nuxt at the root, for the workspace's tooling.
    await writeFile(
      join(worktree, "package.json"),
      '{ "private": true, "devDependencies": { "nuxt": "^4.2.0" } }',
    );
    // A Nuxt app with a React library is still a Nuxt app.
    await writeFile(
      join(shop, "package.json"),
      '{ "dependencies": { "nuxt": "^4.2.0", "react": "19.0.0", "vue": "^3.5.0" } }',
    );
    await writeFile(
      join(legacy, "package.json"),
      '{ "dependencies": { "nuxt": "^2.17.3" } }',
    );
    await writeFile(join(ui, "package.json"), '{ "name": "ui" }');
    await writeFile(join(shop, "app/components/card.blame-preview.ts"), "");
    await writeFile(join(legacy, "components/card.blame-preview.ts"), "");
    await writeFile(join(ui, "src/button.blame-preview.ts"), "");
    const locate = (file: string) =>
      locateComponentPreview({ workspaceMode: "direct", worktree }, file);

    // Nuxt itself is never loaded: Vue is what must be installed.
    assert.match(
      (
        (await locate("apps/shop/app/components/card.blame-preview.ts")) as {
          message: string;
        }
      ).message,
      /^Vue is not installed for apps\/shop in the story's workspace\. open_component_preview never installs the project's dependencies/u,
    );
    await mkdir(join(worktree, "node_modules/vue"), { recursive: true });
    await writeFile(join(worktree, "node_modules/vue/package.json"), "{}");
    const shopLocation = await locate(
      "apps/shop/app/components/card.blame-preview.ts",
    );
    assert.ok("host" in shopLocation, JSON.stringify(shopLocation));
    assert.equal(shopLocation.packageDir, "apps/shop");
    assert.deepEqual(shopLocation.toolkit, { framework: "nuxt" });
    // A package of a Nuxt workspace is no Nuxt app: plain Vue.
    const uiLocation = await locate("packages/ui/src/button.blame-preview.ts");
    assert.ok("host" in uiLocation, JSON.stringify(uiLocation));
    assert.deepEqual(uiLocation.toolkit, { framework: "vue" });
    assert.match(
      (
        (await locate("apps/legacy/components/card.blame-preview.ts")) as {
          message: string;
        }
      ).message,
      /^Nuxt 2 is not supported: apps\/legacy depends on Nuxt 2, which runs Vue 2\. open_component_preview renders the components of Nuxt 3 and 4 apps only\. Check this component in the app instead\.$/u,
    );
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a Nuxt 3 or 4 project gets the tool, a Nuxt 2 project does not", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-nuxt-project-"));
  const offered = async (nuxt: string) => {
    await writeFile(
      join(worktree, "package.json"),
      JSON.stringify({ dependencies: { nuxt } }),
    );
    return hasComponentPreviewProject(worktree);
  };
  try {
    assert.equal(await offered("^2.17.3"), false);
    assert.equal(await offered("^3.17.0"), true);
    assert.equal(await offered("^4.2.0"), true);
    assert.equal(await offered("latest"), true);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});
