import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workspaceComponentPreviewHost } from "./component-preview-hosts.ts";
import {
  componentPreviewToolkitPlugin,
  componentPreviewToolkitVersions,
  type ComponentPreviewToolkit,
} from "./component-preview-server-script.ts";
import {
  ComponentPreviewService,
  type ComponentPreviewCapture,
  type ComponentPreviewPage,
} from "./component-preview-service.ts";

// Small projects rendered by the real temporary server: a Next.js App
// Router app, a Vue CLI app and a Rollup Svelte app, without Vite, with
// Blame's own Vite and @vitejs/plugin-react, @vitejs/plugin-vue or
// @sveltejs/vite-plugin-svelte; SvelteKit 2 and 3 apps with their own Vite
// and sveltekit(). The browser is replaced by requests for the page and the
// modules it loads, or by jsdom, which runs those modules in this process.

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c63f8cfc0f01f0005000201ffa65f6b0000000049454e44ae426082",
  "hex",
);
const dependencies = resolveDependencies();

test(
  "Blame's own Vite and its plugins are the versions Blame's packages use",
  {
    skip:
      dependencies.next && dependencies.vue && dependencies.svelte
        ? false
        : "Vite, @vitejs/plugin-react, @vitejs/plugin-vue or @sveltejs/vite-plugin-svelte is not installed for the desktop tests.",
  },
  () => {
    assert.deepEqual(
      {
        pluginReact: packageVersion(
          dependencies.next!.toolkit["@vitejs/plugin-react"]!,
        ),
        pluginSvelte: packageVersion(
          dependencies.svelte!.toolkit["@sveltejs/vite-plugin-svelte"]!,
        ),
        pluginVue: packageVersion(
          dependencies.vue!.toolkit["@vitejs/plugin-vue"]!,
        ),
        vite: packageVersion(dependencies.next!.toolkit.vite!),
      },
      componentPreviewToolkitVersions,
      "Update componentPreviewToolkitVersions with the versions in the lockfile.",
    );
  },
);

test(
  "a Next.js client component renders with Blame's Vite: Tailwind, tsconfig paths and the Next.js shims",
  {
    skip: dependencies.next
      ? false
      : "Vite, @vitejs/plugin-react, React, Next.js or Tailwind is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-next-"),
    );
    const toolkitRoot = await mkdtemp(
      join(tmpdir(), "blame-component-preview-toolkit-"),
    );
    const responses = new Map<string, string>();
    let service: ComponentPreviewService | undefined;
    try {
      await writeNextFixture(worktree);
      await linkToolkit(toolkitRoot, "next", dependencies.next!.toolkit);
      const page = new FetchingPage(async (url) => {
        const get = async (path: string) => {
          const response = await fetch(new URL(path, url));
          const body = await response.text();
          assert.equal(response.status, 200, `${path}: ${body.slice(0, 600)}`);
          responses.set(path, body);
          return body;
        };
        const html = await get(new URL(url).pathname + new URL(url).search);
        assert.match(html, /virtual:blame-component-preview/u);
        const file = new URL(url).searchParams.get("file")!;
        const preview = await get(`/${file}`);
        for (const path of importedPaths(preview)) await get(path);
        return true;
      });
      service = new ComponentPreviewService({
        browser: async () => ({ openPage: async () => page }),
        locate: async () => ({
          host: workspaceComponentPreviewHost(worktree, undefined, toolkitRoot),
          packageDir: "",
          toolkit: { framework: "next" },
        }),
        storeScreenshots: async (result) => ({
          ...(result as object),
          _meta: { blameScreenshots: [{ id: "1".repeat(64) }] },
        }),
      });
      const result = (await service.render({
        request: { file: "components/profile.blame-preview.tsx" },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.match(
        result.content[0]!.text!,
        /^Started Blame's own Vite 8\.\d+\.\d+ server with @vitejs\/plugin-react, with shims for next\/link, next\/image, next\/navigation and next\/font, in the story's workspace for the worktree root, at http:\/\/127\.0\.0\.1:\d+: the package has no Vite config, so its PostCSS config and tsconfig or jsconfig paths apply\. 1 render of components\/profile\.blame-preview\.tsx:$/u,
      );

      // tsconfig paths: "@/" resolves from the package.
      const preview = responses.get("/components/profile.blame-preview.tsx")!;
      assert.match(preview, /from "\/components\/profile-card\.tsx"/u);
      assert.match(preview, /import "\/app\/globals\.css"/u);

      // "use client" breaks nothing; Next.js imports go to the shims, never
      // to the next package; React comes from the project.
      const card = responses.get("/components/profile-card.tsx")!;
      for (const shim of [
        "next/link",
        "next/image",
        "next/navigation",
        "next/font/google:0",
      ])
        assert.ok(
          card.includes(`/@id/__x00__blame-next:${shim}`),
          `${shim} is not shimmed:\n${card}`,
        );
      assert.doesNotMatch(card, /node_modules\/next\//u);
      assert.match(card, /\.vite-blame-preview-[0-9a-f]+\/deps\/react/u);
      await assertShims(page.origin!);
      // A library that imports next/link itself gets the shim too, in the
      // bundle Vite pre-builds for it.
      const library =
        /"(\/node_modules\/\.vite-blame-preview-[0-9a-f]+\/deps\/fixture-ui\.js[^"]*)"/u.exec(
          card,
        )?.[1];
      assert.ok(library, card);
      const bundle = await bundledCode(page.origin!, library);
      assert.match(bundle, /\\0blame-next:next\/link/u);
      assert.match(bundle, /createElement\)\("a"/u);
      assert.doesNotMatch(bundle, /next\/dist\//u);
      // NEXT_PUBLIC_* variables of its .env files reach process.env, set by
      // Vite's client environment in development; the others never reach
      // the page.
      const client = await (
        await fetch(new URL("/@vite/client", page.origin))
      ).text();
      const envPath = /import "([^"]+\/env\.mjs)"/u.exec(client)?.[1];
      assert.ok(envPath, "Vite's client imports no environment module.");
      const env = await (await fetch(new URL(envPath, page.origin))).text();
      assert.match(
        env,
        /process\.env\.NEXT_PUBLIC_SITE_NAME[^\n]*Fixture site/u,
      );
      assert.doesNotMatch(env, /never-in-the-page/u);

      // Tailwind runs through the project's PostCSS config, on its sources.
      const css = await (
        await fetch(new URL("/app/globals.css?direct", page.origin))
      ).text();
      assert.match(css, /\.bg-emerald-600\s*\{/u);
      assert.match(css, /\.rounded-xl\s*\{/u);
      // next/image sources come from public/, as in Next.
      const avatar = await fetch(new URL("/avatar.png", page.origin));
      assert.equal(avatar.status, 200);
      assert.match(avatar.headers.get("content-type") ?? "", /image\/png/u);

      // A Server Component's server-only import fails with a clear message.
      const account = await (
        await fetch(new URL("/app/account/page.tsx", page.origin))
      ).text();
      const serverOnly = /"(\/@id\/__x00__blame-server-only:\d+)"/u.exec(
        account,
      )?.[1];
      assert.ok(serverOnly, account);
      assert.match(
        await (await fetch(new URL(serverOnly, page.origin))).text(),
        /throw new Error\("app\/account\/page\.tsx imports \\"next\/headers\\", which runs only on the server: it is part of a Server Component\. open_component_preview renders client components in the browser: preview one of its client sub-components with made-up props, or check this screen in the full app\."\)/u,
      );
      // The entry Vite serves reports an async component, such as the
      // page.tsx Server Component, instead of rendering it.
      const entry = await fetch(
        new URL("/@id/__x00__virtual:blame-component-preview", page.origin),
      );
      const entryCode = await entry.text();
      assert.equal(entry.status, 200, entryCode.slice(0, 600));
      assert.match(entryCode, /\[object AsyncFunction\]/u);
      assert.match(
        entryCode,
        /is an async component: React renders async components only as Server Components/u,
      );
      assert.equal(await service.stop({ worktree }), 1);
    } finally {
      await service?.shutdown();
      await rm(worktree, { force: true, recursive: true });
      await rm(toolkitRoot, { force: true, recursive: true });
    }
  },
);

test(
  "a Vue CLI component renders with Blame's Vite: its <style> and <style scoped> blocks, Tailwind, jsconfig paths and the @ alias",
  {
    skip: dependencies.vue
      ? false
      : "Vite, @vitejs/plugin-vue, Vue or Tailwind is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-vue-"),
    );
    const toolkitRoot = await mkdtemp(
      join(tmpdir(), "blame-component-preview-toolkit-"),
    );
    const responses = new Map<string, string>();
    let service: ComponentPreviewService | undefined;
    try {
      await writeVueCliFixture(worktree);
      await linkToolkit(toolkitRoot, "vue", dependencies.vue!.toolkit);
      const page = new FetchingPage(async (url) => {
        const get = async (path: string) => {
          const response = await fetch(new URL(path, url));
          const body = await response.text();
          assert.equal(response.status, 200, `${path}: ${body.slice(0, 600)}`);
          responses.set(path, body);
          return body;
        };
        const html = await get(new URL(url).pathname + new URL(url).search);
        assert.match(html, /virtual:blame-component-preview/u);
        // The preview file and every project module it loads, the blocks
        // of each .vue file included.
        const pending = [`/${new URL(url).searchParams.get("file")!}`];
        for (let path = pending.shift(); path; path = pending.shift())
          if (!responses.has(path))
            pending.push(...importedPaths(await get(path)));
        return true;
      });
      service = new ComponentPreviewService({
        browser: async () => ({ openPage: async () => page }),
        locate: async () => ({
          host: workspaceComponentPreviewHost(worktree, undefined, toolkitRoot),
          packageDir: "",
          toolkit: { framework: "vue" },
        }),
        storeScreenshots: async (result) => ({
          ...(result as object),
          _meta: { blameScreenshots: [{ id: "2".repeat(64) }] },
        }),
      });
      const result = (await service.render({
        request: {
          file: "src/components/profile.blame-preview.ts",
          states: ["default", "long"],
        },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.match(
        result.content[0]!.text!,
        /^Started Blame's own Vite 8\.\d+\.\d+ server with @vitejs\/plugin-vue, in the story's workspace for the worktree root, at http:\/\/127\.0\.0\.1:\d+: the package has no Vite config, so its PostCSS config and tsconfig or jsconfig paths apply\. In a Vue CLI package, @\/ resolves to src\/\. 2 renders of src\/components\/profile\.blame-preview\.ts:$/u,
      );
      assert.deepEqual(
        result.content
          .slice(1)
          .filter(({ type }) => type === "text")
          .map(({ text }) => text!.split("\n")[0]),
        [
          "Render 1/2 — default, light, 1280 px: rendered.",
          "Render 2/2 — long, light, 1280 px: rendered.",
        ],
        JSON.stringify(result.content),
      );

      // Vue CLI's alias: "@/" resolves from src. Vue comes from the
      // project, bundled up front.
      const preview = responses.get(
        "/src/components/profile.blame-preview.ts",
      )!;
      assert.match(preview, /from "\/src\/components\/ProfileCard\.vue"/u);
      assert.match(preview, /import "\/src\/assets\/tailwind\.css"/u);
      assert.match(preview, /\.vite-blame-preview-[0-9a-f]+\/deps\/vue\.js/u);

      // The single-file component is compiled, its <script setup lang="ts">
      // included; "@ui/" resolves with the paths of jsconfig.json.
      const card = responses.get("/src/components/ProfileCard.vue")!;
      assert.doesNotMatch(card, /<template>|defineProps</u);
      assert.match(card, /from "\/src\/ui\/StatusBadge\.vue"/u);
      const scopeId = /["']__scopeId["'],\s*["'](data-v-[0-9a-f]+)["']/u.exec(
        card,
      )?.[1];
      assert.ok(scopeId, card);
      // <style scoped> gets the component's attribute, <style> stays global.
      const style = (file: string) =>
        [...responses].find(([path]) =>
          path.startsWith(`${file}?vue&type=style&index=0`),
        )?.[1] ?? "";
      assert.match(
        style("/src/components/ProfileCard.vue"),
        new RegExp(`\\.card\\[${scopeId}\\]`, "u"),
        [...responses.keys()].join("\n"),
      );
      const badge = style("/src/ui/StatusBadge.vue");
      assert.match(
        badge,
        /\.status-badge \{/u,
        [...responses.keys()].join("\n"),
      );
      assert.doesNotMatch(badge, /data-v-/u);

      // Tailwind runs through the project's PostCSS config, on its .vue
      // files too.
      const css = await (
        await fetch(new URL("/src/assets/tailwind.css?direct", page.origin))
      ).text();
      assert.match(css, /\.bg-emerald-600\s*\{/u);
      assert.match(css, /\.rounded-full\s*\{/u);
      // VUE_APP_* variables of its .env files reach process.env, as Vue CLI
      // inlines them; the others never reach the page.
      const client = await (
        await fetch(new URL("/@vite/client", page.origin))
      ).text();
      const envPath = /import "([^"]+\/env\.mjs)"/u.exec(client)?.[1];
      assert.ok(envPath, "Vite's client imports no environment module.");
      const env = await (await fetch(new URL(envPath, page.origin))).text();
      assert.match(env, /process\.env\.VUE_APP_TITLE[^\n]*Fixture shop/u);
      assert.doesNotMatch(env, /never-in-the-page/u);

      // Every state goes through mount; React plays no part.
      const entry = await fetch(
        new URL("/@id/__x00__virtual:blame-component-preview", page.origin),
      );
      const entryCode = await entry.text();
      assert.equal(entry.status, 200, entryCode.slice(0, 600));
      assert.match(
        entryCode,
        /createApp\(Component, props\)\.mount\(element\)/u,
      );
      assert.doesNotMatch(entryCode, /react-dom/u);
      assert.equal(await service.stop({ worktree }), 1);
    } finally {
      await service?.shutdown();
      await rm(worktree, { force: true, recursive: true });
      await rm(toolkitRoot, { force: true, recursive: true });
    }
  },
);

test(
  "an installed Vue 2 is reported as not supported before Blame's Vite compiles anything",
  { timeout: 60_000 },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-vue2-"),
    );
    let service: ComponentPreviewService | undefined;
    try {
      // A tag says nothing of the version: only the installed one tells.
      await writeFile(
        join(worktree, "package.json"),
        JSON.stringify({ dependencies: { vue: "latest" } }),
      );
      await mkdir(join(worktree, "node_modules/vue"), { recursive: true });
      await writeFile(
        join(worktree, "node_modules/vue/package.json"),
        JSON.stringify({ name: "vue", version: "2.7.16", main: "index.js" }),
      );
      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(
        join(worktree, "src/card.blame-preview.ts"),
        "export function mount() {}\n",
      );
      service = new ComponentPreviewService({
        browser: async () => {
          throw new Error("A server that did not start opens no page.");
        },
        locate: async () => ({
          // Never installed: the check comes first.
          host: workspaceComponentPreviewHost(
            worktree,
            undefined,
            join(worktree, "toolkit"),
          ),
          packageDir: "",
          toolkit: { framework: "vue" },
        }),
        storeScreenshots: async (result) => result,
      });
      const result = (await service.render({
        request: { file: "src/card.blame-preview.ts" },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, true);
      assert.match(
        result.content[0]!.text!,
        /^The component preview server did not start in the story's workspace: Vue 2 is not supported: \S+ has vue 2\.7\.16 installed, and without a Vite config open_component_preview renders Vue 3\.2\.25 or later only\. Check this component in the app instead\.$/u,
      );
      assert.equal(existsSync(join(worktree, "toolkit")), false);
    } finally {
      await service?.shutdown();
      await rm(worktree, { force: true, recursive: true });
    }
  },
);

test(
  "a SvelteKit 2 component renders with the project's own Vite and sveltekit(): $lib, $app/navigation, $app/state, $app/stores and $env/static/public",
  {
    skip:
      dependencies.sveltekit2 && dependencies.jsdom
        ? false
        : "SvelteKit 2, Svelte, @sveltejs/vite-plugin-svelte, Vite or jsdom is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const { page, text } = await renderSvelteKitFixture((worktree) =>
      writeSvelteKit2Fixture(worktree),
    );
    assert.match(
      text[0]!,
      /^Started a Vite 8\.\d+\.\d+ server in the story's workspace for the worktree root, at http:\/\/127\.0\.0\.1:\d+\. 1 render of src\/lib\/components\/profile\.blame-preview\.ts:$/u,
    );
    assert.match(
      text[1]!,
      /^Render 1\/1 — default, light, 1280 px: rendered\./u,
      text[1],
    );
    // $lib and $env/static/public; $app/state and $app/stores both give
    // the page a URL.
    assert.match(page.rendered, /<span class="avatar svelte-\w+">AL<\/span>/u);
    assert.match(
      page.rendered,
      /<p class="store svelte-\w+">Fixture store<\/p>/u,
    );
    assert.match(page.rendered, /<p class="path svelte-\w+">\/ · \/<\/p>/u);
    // The page carries the public variables, never the private ones.
    assert.match(page.html, /"PUBLIC_STORE_NAME":"Fixture store"/u);
    assert.doesNotMatch(page.html + page.rendered, /never-in-the-page/u);
    // The stylesheet the preview file imports, and the component's own.
    assert.match(page.styles, /\.profile-card \{[^}]*border: 2px solid/u);
    assert.match(page.styles, /\.avatar\.svelte-\w+ \{/u);
  },
);

test(
  "a SvelteKit 3 component renders with the project's own Vite and sveltekit(): #lib, $app/navigation, $app/state and $app/env/public",
  {
    skip:
      dependencies.sveltekit3 && dependencies.jsdom
        ? false
        : "SvelteKit 3, Svelte, @sveltejs/vite-plugin-svelte, Vite or jsdom is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const { page, text } = await renderSvelteKitFixture((worktree) =>
      writeSvelteKit3Fixture(worktree),
    );
    assert.match(
      text[1]!,
      /^Render 1\/1 — default, light, 1280 px: rendered\./u,
      text[1],
    );
    // A dynamic and a static public variable, declared in src/env.ts.
    assert.match(
      page.rendered,
      /<p class="store">Fixture store · eu-west<\/p>/u,
    );
    assert.match(page.rendered, /<span class="avatar">AL<\/span>/u);
    // The preview file set the page before it mounted.
    assert.match(page.rendered, /<p class="path">\/account<\/p>/u);
    assert.match(page.html, /"PUBLIC_STORE_NAME":"Fixture store"/u);
    assert.doesNotMatch(page.html + page.rendered, /never-in-the-page/u);
    assert.match(page.styles, /\.profile-card \{[^}]*border: 2px solid/u);
  },
);

test(
  "a Svelte 5 component without Vite renders with Blame's Vite and @sveltejs/vite-plugin-svelte, compiled by the project's own Svelte",
  {
    skip:
      dependencies.svelte && dependencies.jsdom
        ? false
        : "Vite, @sveltejs/vite-plugin-svelte, Svelte or jsdom is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-svelte-"),
    );
    const toolkitRoot = await mkdtemp(
      join(tmpdir(), "blame-component-preview-toolkit-"),
    );
    const page = new DomPage();
    let service: ComponentPreviewService | undefined;
    try {
      await writeSvelteRollupFixture(worktree);
      await linkSvelteToolkit(toolkitRoot, dependencies.svelte!.toolkit);
      service = new ComponentPreviewService({
        browser: async () => ({ openPage: async () => page }),
        locate: async () => ({
          host: workspaceComponentPreviewHost(worktree, undefined, toolkitRoot),
          packageDir: "",
          toolkit: { framework: "svelte" },
        }),
        storeScreenshots: async (result) => ({
          ...(result as object),
          _meta: { blameScreenshots: [{ id: "4".repeat(64) }] },
        }),
      });
      const result = (await service.render({
        request: { file: "src/lib/counter.blame-preview.ts" },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.match(
        result.content[0]!.text!,
        /^Started Blame's own Vite 8\.\d+\.\d+ server with @sveltejs\/vite-plugin-svelte, in the story's workspace for the worktree root, at http:\/\/127\.0\.0\.1:\d+: the package has no Vite config, so its PostCSS config and tsconfig or jsconfig paths apply\. The package's own Svelte compiles its components, with its svelte\.config\.\* if it has one\. 1 render of src\/lib\/counter\.blame-preview\.ts:$/u,
      );
      assert.match(
        result.content[1]!.text!,
        /^Render 1\/1 — default, light, 1280 px: rendered\./u,
        result.content[1]!.text,
      );
      // $props, $state and $derived ran; tsconfig paths resolved @lib/.
      assert.match(
        page.rendered,
        /<button class="counter svelte-\w+">Clicks: 03 \(6\)<\/button>/u,
      );
      assert.match(page.styles, /\.page \{/u);
      assert.match(
        page.styles,
        /\.counter\.svelte-\w+ \{\s*border-radius: 9999px;/u,
      );

      // Every state goes through mount; React plays no part.
      const entry = await fetch(
        new URL("/@id/__x00__virtual:blame-component-preview", page.origin),
      );
      const entryCode = await entry.text();
      assert.equal(entry.status, 200, entryCode.slice(0, 600));
      assert.match(
        entryCode,
        /mount\(Component, \{ target: element, props \}\)/u,
      );
      assert.doesNotMatch(entryCode, /react-dom/u);
      assert.equal(await service.stop({ worktree }), 1);
    } finally {
      await service?.shutdown();
      await rm(worktree, { force: true, recursive: true });
      await rm(toolkitRoot, { force: true, recursive: true });
    }
  },
);

test(
  "an installed Svelte 4 is reported as not supported before Blame's Vite compiles anything",
  { timeout: 60_000 },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-svelte4-"),
    );
    let service: ComponentPreviewService | undefined;
    try {
      // A tag says nothing of the version: only the installed one tells.
      await writeFixtureFiles(worktree, {
        "package.json": JSON.stringify({
          devDependencies: { svelte: "latest" },
        }),
        "node_modules/svelte/package.json": JSON.stringify({
          name: "svelte",
          version: "4.2.19",
          main: "index.js",
        }),
        "src/card.blame-preview.ts": "export function mount() {}\n",
      });
      service = new ComponentPreviewService({
        browser: async () => {
          throw new Error("A server that did not start opens no page.");
        },
        locate: async () => ({
          // Never installed: the check comes first.
          host: workspaceComponentPreviewHost(
            worktree,
            undefined,
            join(worktree, "toolkit"),
          ),
          packageDir: "",
          toolkit: { framework: "svelte" },
        }),
        storeScreenshots: async (result) => result,
      });
      const result = (await service.render({
        request: { file: "src/card.blame-preview.ts" },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, true);
      assert.match(
        result.content[0]!.text!,
        /^The component preview server did not start in the story's workspace: Svelte 4 is not supported: \S+ has svelte 4\.2\.19 installed, and without a Vite config open_component_preview renders Svelte 5\.46\.4 or later only\. Check this component in the app instead\.$/u,
      );
      assert.equal(existsSync(join(worktree, "toolkit")), false);
    } finally {
      await service?.shutdown();
      await rm(worktree, { force: true, recursive: true });
    }
  },
);

// Renders the preview file of a SvelteKit fixture with its own Vite and
// config, in jsdom.
async function renderSvelteKitFixture(
  write: (worktree: string) => Promise<void>,
) {
  const worktree = await mkdtemp(
    join(tmpdir(), "blame-component-preview-sveltekit-"),
  );
  const page = new DomPage();
  const service = new ComponentPreviewService({
    browser: async () => ({ openPage: async () => page }),
    locate: async () => ({
      host: workspaceComponentPreviewHost(worktree),
      packageDir: "",
    }),
    storeScreenshots: async (result) => ({
      ...(result as object),
      _meta: { blameScreenshots: [{ id: "3".repeat(64) }] },
    }),
  });
  try {
    await write(worktree);
    const result = (await service.render({
      request: { file: "src/lib/components/profile.blame-preview.ts" },
      worktree,
    })) as {
      content: Array<{ text?: string; type: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(await service.stop({ worktree }), 1);
    return {
      page,
      text: result.content
        .filter(({ type }) => type === "text")
        .map(({ text }) => text!),
    };
  } finally {
    await service.shutdown();
    await rm(worktree, { force: true, recursive: true });
  }
}

async function assertShims(origin: string) {
  const shim = async (id: string) => {
    const response = await fetch(
      new URL(`/@id/__x00__blame-next:${id}`, origin),
    );
    const body = await response.text();
    assert.equal(response.status, 200, `${id}: ${body.slice(0, 600)}`);
    return body;
  };
  assert.match(await shim("next/link"), /createElement\("a"/u);
  assert.match(await shim("next/image"), /createElement\("img"/u);
  assert.match(await shim("next/navigation"), /export function usePathname/u);
  assert.match(
    await shim("next/font/google:0"),
    /export const Geist_Mono = googleFont\("Geist Mono"\)/u,
  );
  assert.match(await shim("font-runtime"), /export function localFont/u);
}

// A pre-bundled dependency with the chunks it imports.
async function bundledCode(origin: string, path: string) {
  const code = await (await fetch(new URL(path, origin))).text();
  const chunks = [...code.matchAll(/from "(\.\/[^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  const parts = await Promise.all(
    chunks.map(async (chunk) =>
      (await fetch(new URL(chunk, new URL(path, origin)))).text(),
    ),
  );
  return [code, ...parts].join("\n");
}

// The project modules and shims a transformed module imports.
function importedPaths(code: string) {
  return [
    ...code.matchAll(/(?:from|import) "(\/(?!@vite\/|node_modules\/)[^"]+)"/gu),
  ]
    .map((match) => match[1]!)
    .filter((path) => !path.includes("/.vite-blame-preview-"));
}

class FetchingPage implements ComponentPreviewPage {
  origin?: string;
  private readonly load: (url: string) => Promise<true>;

  constructor(load: (url: string) => Promise<true>) {
    this.load = load;
  }

  async capture(input: {
    theme: "dark" | "light";
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture> {
    this.origin = new URL(input.url).origin;
    await this.load(input.url);
    return {
      consoleErrors: [],
      image: png,
      status: "ready",
      url: input.url,
      viewport: { height: 900, width: input.width },
    };
  }

  close() {}
}

// jsdom in place of the browser: the page's modules run in this process,
// loaded over HTTP from the preview server. Each page renders once.
class DomPage implements ComponentPreviewPage {
  origin?: string;
  // The page as the server sent it.
  html = "";
  // The markup of the page's root element, and its styles, once rendered.
  rendered = "";
  styles = "";

  async capture(input: {
    theme: "dark" | "light";
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture> {
    this.origin = new URL(input.url).origin;
    const response = await fetch(input.url);
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 600));
    this.html = html;
    const { JSDOM } = createRequire(import.meta.url)(dependencies.jsdom!) as {
      JSDOM: new (
        html: string,
        options: {
          pretendToBeVisual: boolean;
          runScripts: "dangerously";
          url: string;
        },
      ) => { window: Window & typeof globalThis };
    };
    // Its inline scripts run, its module scripts are imported below.
    const { window } = new JSDOM(html, {
      pretendToBeVisual: true,
      runScripts: "dangerously",
      url: input.url,
    });
    const restore = useWindowGlobals(window);
    try {
      useHttpModules();
      await import(
        new URL("/@id/__x00__virtual:blame-component-preview", input.url).href
      );
      const { dataset } = window.document.documentElement;
      const deadline = Date.now() + 20_000;
      while (!dataset.blamePreviewStatus && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      this.rendered = window.document.getElementById("root")!.innerHTML;
      this.styles = [...window.document.querySelectorAll("style")]
        .map((style) => style.textContent)
        .join("\n");
      const status = dataset.blamePreviewStatus;
      return {
        consoleErrors: [],
        image: png,
        ...(dataset.blamePreviewMessage
          ? { message: dataset.blamePreviewMessage }
          : {}),
        status: status === "ready" || status === "error" ? status : "timeout",
        url: input.url,
        viewport: { height: 900, width: input.width },
      };
    } finally {
      restore();
      window.close();
    }
  }

  close() {}
}

// The page's globals, as a browser has them, until `restore` is called;
// those the page's modules set go too.
function useWindowGlobals(window: Window & typeof globalThis) {
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    if (!replaced.has(name))
      replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  };
  const page = window as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(window))
    if (!(name in globalThis)) set(name, page[name]);
  // Node has its own: the page's DOM only accepts jsdom's.
  for (const name of ["CustomEvent", "Event", "navigator"])
    set(name, page[name]);
  for (const name of [
    "addEventListener",
    "dispatchEvent",
    "removeEventListener",
  ] as const)
    set(name, window[name].bind(window));
  return () => {
    for (const name of Object.getOwnPropertyNames(globalThis))
      if (!before.has(name)) Reflect.deleteProperty(globalThis, name);
    for (const [name, descriptor] of replaced)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  };
}

// Vite's HMR client in the page, reduced to what modules call when they
// load: CSS modules inject their styles. Like the real one, it first loads
// Vite's environment module, which sets the config's defines as globals.
const viteClientStub = [
  "export function createHotContext() {",
  "  return { data: {}, accept() {}, acceptExports() {}, dispose() {}, invalidate() {}, off() {}, on() {}, prune() {}, send() {} };",
  "}",
  "const styles = new Map();",
  "export function updateStyle(id, css) {",
  "  let style = styles.get(id);",
  "  if (!style) {",
  '    style = document.createElement("style");',
  "    document.head.appendChild(style);",
  "    styles.set(id, style);",
  "  }",
  "  style.textContent = css;",
  "}",
  "export function removeStyle(id) {",
  "  styles.get(id)?.remove();",
  "  styles.delete(id);",
  "}",
  "export function injectQuery(url) {",
  "  return url;",
  "}",
  "export class ErrorOverlay {}",
].join("\n");

const httpModuleHooks = [
  `const viteClient = ${JSON.stringify(viteClientStub)};`,
  "export async function resolve(specifier, context, nextResolve) {",
  '  if (specifier.startsWith("http:")) return { shortCircuit: true, url: specifier };',
  '  if (context.parentURL && context.parentURL.startsWith("http:")) return { shortCircuit: true, url: new URL(specifier, context.parentURL).href };',
  "  return nextResolve(specifier, context);",
  "}",
  "export async function load(url, context, nextLoad) {",
  '  if (!url.startsWith("http:")) return nextLoad(url, context);',
  "  const response = await fetch(url);",
  "  const source = await response.text();",
  '  if (!response.ok) throw new Error(url + " answered " + response.status + ": " + source.slice(0, 1000));',
  '  if (new URL(url).pathname === "/@vite/client") {',
  "    const env = /import\\s*[\"']([^\"']+\\/env\\.mjs)[\"']/.exec(source);",
  '    if (!env) throw new Error("Vite\'s client imports no environment module.");',
  '    return { format: "module", shortCircuit: true, source: "import " + JSON.stringify(env[1]) + ";\\n" + viteClient };',
  "  }",
  '  return { format: "module", shortCircuit: true, source };',
  "}",
].join("\n");

let httpModules = false;

// Lets this process import the modules a preview server serves.
function useHttpModules() {
  if (httpModules) return;
  register(
    `data:text/javascript,${encodeURIComponent(httpModuleHooks)}`,
    import.meta.url,
  );
  httpModules = true;
}

async function writeFixtureFiles(
  worktree: string,
  files: Record<string, string>,
) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(worktree, path)), { recursive: true });
    await writeFile(join(worktree, path), content);
  }
}

async function writeNextFixture(worktree: string) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "next-fixture",
      private: true,
      scripts: { dev: "next dev" },
      dependencies: { next: "16.4.3", react: "19.3.1", "react-dom": "19.3.1" },
      devDependencies: {
        "@tailwindcss/postcss": "4.3.3",
        tailwindcss: "4.3.3",
      },
    }),
    "next.config.mjs": "export default {};\n",
    "tsconfig.json": [
      "{",
      "  // As create-next-app writes it.",
      '  "compilerOptions": {',
      '    "jsx": "preserve",',
      '    "moduleResolution": "bundler",',
      '    "paths": { "@/*": ["./*"] },',
      "  },",
      "}",
      "",
    ].join("\n"),
    "postcss.config.mjs":
      'export default { plugins: { "@tailwindcss/postcss": {} } };\n',
    ".env.local":
      "NEXT_PUBLIC_SITE_NAME=Fixture site\nDATABASE_PASSWORD=never-in-the-page\n",
    "app/globals.css": '@import "tailwindcss";\n',
    "app/layout.tsx": [
      'import { Geist } from "next/font/google";',
      'import "./globals.css";',
      'const geist = Geist({ subsets: ["latin"] });',
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      '  return <html lang="en"><body className={geist.className}>{children}</body></html>;',
      "}",
      "",
    ].join("\n"),
    "app/page.tsx": [
      'import { ProfileCard } from "@/components/profile-card";',
      "export default async function Home() {",
      '  const name = await Promise.resolve("Ada Lovelace");',
      "  return <main><ProfileCard name={name} /></main>;",
      "}",
      "",
    ].join("\n"),
    "app/account/page.tsx": [
      'import { cookies } from "next/headers";',
      "export default async function Account() {",
      '  const session = (await cookies()).get("session");',
      "  return <p>{session?.value}</p>;",
      "}",
      "",
    ].join("\n"),
    "components/profile-card.tsx": [
      '"use client";',
      "",
      'import Image from "next/image";',
      'import Link from "next/link";',
      'import { usePathname } from "next/navigation";',
      'import { Geist_Mono } from "next/font/google";',
      'import { NavLink } from "fixture-ui";',
      "",
      'const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });',
      "",
      "export function ProfileCard({ name }: { name: string }) {",
      "  const pathname = usePathname();",
      "  return (",
      "    <section className={`${mono.variable} rounded-xl bg-emerald-600 p-6 text-white`}>",
      '      <Image src="/avatar.png" alt="" width={48} height={48} />',
      '      <h2 className="text-2xl font-bold">{name}</h2>',
      "      <p>{process.env.NEXT_PUBLIC_SITE_NAME} · {pathname}</p>",
      '      <Link href={{ pathname: "/settings", query: { tab: "profile" } }} className="underline">Settings</Link>',
      '      <NavLink href="/help">Help</NavLink>',
      "    </section>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "components/profile.blame-preview.tsx": [
      'import "@/app/globals.css";',
      'import { ProfileCard } from "@/components/profile-card";',
      'import Home from "@/app/page";',
      "",
      'export default <ProfileCard name="Ada Lovelace" />;',
      "export const page = <Home />;",
      "",
    ].join("\n"),
    "app/account.blame-preview.tsx": [
      'import Account from "@/app/account/page";',
      "export default <Account />;",
      "",
    ].join("\n"),
    // A "use client" library of the project that imports next/link.
    "node_modules/fixture-ui/package.json": JSON.stringify({
      name: "fixture-ui",
      type: "module",
      exports: "./index.js",
    }),
    "node_modules/fixture-ui/index.js": [
      '"use client";',
      'import Link from "next/link";',
      'import { createElement } from "react";',
      "export function NavLink(props) {",
      "  return createElement(Link, props);",
      "}",
      "",
    ].join("\n"),
  };
  await writeFixtureFiles(worktree, files);
  await mkdir(join(worktree, "public"), { recursive: true });
  await writeFile(join(worktree, "public/avatar.png"), png);
  await linkProjectDependencies(worktree, dependencies.next!.project);
}

// A project created by `vue create` with Vue 3: no Vite, its webpack alias
// @ for src, PostCSS with Tailwind and a .env file. Its jsconfig.json has
// a path of its own, but no @ path, as before Vue CLI 5: the alias alone
// resolves @/.
async function writeVueCliFixture(worktree: string) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "vue-cli-fixture",
      version: "0.1.0",
      private: true,
      scripts: { serve: "vue-cli-service serve" },
      dependencies: { vue: "^3.5.45" },
      devDependencies: {
        "@tailwindcss/postcss": "4.3.3",
        "@vue/cli-service": "~5.0.8",
        tailwindcss: "4.3.3",
      },
    }),
    "vue.config.js":
      'const { defineConfig } = require("@vue/cli-service");\nmodule.exports = defineConfig({ transpileDependencies: true });\n',
    "jsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "./",
        module: "esnext",
        moduleResolution: "node",
        paths: { "@ui/*": ["src/ui/*"] },
      },
    }),
    "postcss.config.js":
      'module.exports = { plugins: { "@tailwindcss/postcss": {} } };\n',
    ".env": "VUE_APP_TITLE=Fixture shop\nSHOP_SECRET=never-in-the-page\n",
    "src/main.js": [
      'import { createApp } from "vue";',
      'import App from "./App.vue";',
      'import "./assets/tailwind.css";',
      "",
      'createApp(App).mount("#app");',
      "",
    ].join("\n"),
    "src/App.vue": [
      "<template>",
      '  <ProfileCard name="Ada Lovelace" status="Active" />',
      "</template>",
      "",
      "<script>",
      'import ProfileCard from "@/components/ProfileCard.vue";',
      "export default { components: { ProfileCard } };",
      "</script>",
      "",
    ].join("\n"),
    "src/assets/tailwind.css": '@import "tailwindcss";\n',
    "src/components/ProfileCard.vue": [
      "<template>",
      '  <section class="card rounded-xl bg-emerald-600 p-6 text-white">',
      '    <h2 class="text-2xl font-bold">{{ name }}</h2>',
      '    <p class="shop">{{ shop }}</p>',
      '    <StatusBadge :label="status" />',
      "  </section>",
      "</template>",
      "",
      '<script setup lang="ts">',
      'import StatusBadge from "@ui/StatusBadge.vue";',
      "",
      "defineProps<{ name: string; status: string }>();",
      "const shop = process.env.VUE_APP_TITLE;",
      "</script>",
      "",
      "<style scoped>",
      ".card {",
      "  box-shadow: 0 0 0 4px rgb(16 185 129 / 0.3);",
      "}",
      "</style>",
      "",
    ].join("\n"),
    "src/ui/StatusBadge.vue": [
      "<template>",
      '  <span class="status-badge rounded-full bg-white/20 px-2 text-xs">{{ label }}</span>',
      "</template>",
      "",
      "<script>",
      "export default { props: { label: String } };",
      "</script>",
      "",
      "<style>",
      ".status-badge {",
      "  letter-spacing: 0.05em;",
      "}",
      "</style>",
      "",
    ].join("\n"),
    "src/components/profile.blame-preview.ts": [
      'import { createApp } from "vue";',
      'import "@/assets/tailwind.css";',
      'import ProfileCard from "@/components/ProfileCard.vue";',
      "",
      "const states: Record<string, { name: string; status: string }> = {",
      '  default: { name: "Ada Lovelace", status: "Active" },',
      '  long: { name: "Augusta Ada King, Countess of Lovelace", status: "Away" },',
      "};",
      "",
      "export function mount(element: HTMLElement, state: string) {",
      "  createApp(ProfileCard, states[state]).mount(element);",
      "}",
      "",
    ].join("\n"),
  };
  await writeFixtureFiles(worktree, files);
  await linkProjectDependencies(worktree, dependencies.vue!.project);
}

const svelteKitAppHtml = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  "    %sveltekit.head%",
  "  </head>",
  '  <body data-sveltekit-preload-data="hover">',
  '    <div style="display: contents">%sveltekit.body%</div>',
  "  </body>",
  "</html>",
  "",
].join("\n");

// What a SvelteKit app made by `sv create` has besides its components.
function svelteKitAppFiles(kitVersion: string) {
  return {
    ".env":
      "PUBLIC_STORE_NAME=Fixture store\nPUBLIC_REGION=eu-west\nSTRIPE_SECRET=never-in-the-page\n",
    "vite.config.js": [
      'import { sveltekit } from "@sveltejs/kit/vite";',
      "",
      "export default { plugins: [sveltekit()] };",
      "",
    ].join("\n"),
    "src/app.html": svelteKitAppHtml,
    "src/app.css": ".profile-card {\n  border: 2px solid rgb(16 185 129);\n}\n",
    "src/routes/+layout.svelte": [
      "<script>",
      '  import "../app.css";',
      "  let { children } = $props();",
      "</script>",
      "",
      "{@render children()}",
      "",
    ].join("\n"),
    "src/lib/components/profile.blame-preview.ts": [
      'import { mount as mountComponent } from "svelte";',
      'import "../../app.css";',
      'import ProfileCard from "./ProfileCard.svelte";',
      "",
      "const states: Record<string, { name: string }> = {",
      '  default: { name: "Ada Lovelace" },',
      '  long: { name: "Augusta Ada King, Countess of Lovelace" },',
      "};",
      "",
      "export function mount(element: HTMLElement, state: string) {",
      "  mountComponent(ProfileCard, { target: element, props: states[state] });",
      "}",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({
      name: `sveltekit-${kitVersion.split(".")[0]}-fixture`,
      private: true,
      version: "0.0.1",
      type: "module",
      scripts: { dev: "vite dev" },
      ...(kitVersion.startsWith("3.")
        ? { imports: { "#lib": "./src/lib/index.js", "#lib/*": "./src/lib/*" } }
        : {}),
      devDependencies: {
        "@sveltejs/kit": `^${kitVersion}`,
        "@sveltejs/vite-plugin-svelte": "^7.3.1",
        svelte: "^5.57.3",
        vite: "^8.3.5",
      },
    }),
  };
}

// A component of a SvelteKit 2 app that reads what only SvelteKit
// provides: $lib, $app/navigation, $app/state, $app/stores and
// $env/static/public.
async function writeSvelteKit2Fixture(worktree: string) {
  await writeFixtureFiles(worktree, {
    ...svelteKitAppFiles("2.70.4"),
    "svelte.config.js": "export default { kit: {} };\n",
    "src/routes/+page.svelte": [
      "<script>",
      '  import ProfileCard from "$lib/components/ProfileCard.svelte";',
      "</script>",
      "",
      '<ProfileCard name="Ada Lovelace" />',
      "",
    ].join("\n"),
    "src/lib/format.ts": [
      "export function initials(name: string) {",
      '  return name.split(" ").map((part) => part[0]).join("");',
      "}",
      "",
    ].join("\n"),
    "src/lib/components/ProfileCard.svelte": [
      '<script lang="ts">',
      '  import { goto } from "$app/navigation";',
      '  import { page } from "$app/state";',
      '  import { page as pageStore } from "$app/stores";',
      '  import { PUBLIC_STORE_NAME } from "$env/static/public";',
      '  import { initials } from "$lib/format";',
      "",
      "  let { name }: { name: string } = $props();",
      "</script>",
      "",
      '<section class="profile-card">',
      '  <span class="avatar">{initials(name)}</span>',
      "  <h2>{name}</h2>",
      '  <p class="store">{PUBLIC_STORE_NAME}</p>',
      '  <p class="path">{page.url.pathname} · {$pageStore.url.pathname}</p>',
      '  <button onclick={() => goto("/settings")}>Settings</button>',
      "</section>",
      "",
      "<style>",
      "  .avatar {",
      "    font-weight: 700;",
      "  }",
      "</style>",
      "",
    ].join("\n"),
  });
  await linkProjectDependencies(worktree, dependencies.sveltekit2!.project);
}

// The same component in a SvelteKit 3 app, with what replaced $lib and
// $env/*: #lib in package.json, $app/env/public and src/env.ts.
async function writeSvelteKit3Fixture(worktree: string) {
  await writeFixtureFiles(worktree, {
    ...svelteKitAppFiles("3.1.1"),
    "src/lib/components/profile.blame-preview.ts": [
      'import { page } from "$app/state";',
      'import { mount as mountComponent } from "svelte";',
      'import "../../app.css";',
      'import ProfileCard from "#lib/components/ProfileCard.svelte";',
      "",
      "export function mount(element: HTMLElement) {",
      '  Object.assign(page, { url: new URL("/account", location.href) });',
      '  mountComponent(ProfileCard, { target: element, props: { name: "Ada Lovelace" } });',
      "}",
      "",
    ].join("\n"),
    "src/env.ts": [
      'import { defineEnvVars } from "@sveltejs/kit/env";',
      "",
      "export const variables = defineEnvVars({",
      "  PUBLIC_STORE_NAME: { public: true },",
      "  PUBLIC_REGION: { public: true, static: true },",
      "  STRIPE_SECRET: {},",
      "});",
      "",
    ].join("\n"),
    "src/routes/+page.svelte": [
      "<script>",
      '  import ProfileCard from "#lib/components/ProfileCard.svelte";',
      "</script>",
      "",
      '<ProfileCard name="Ada Lovelace" />',
      "",
    ].join("\n"),
    "src/lib/index.js": 'export { initials } from "./format.js";\n',
    "src/lib/format.js": [
      "export function initials(name) {",
      '  return name.split(" ").map((part) => part[0]).join("");',
      "}",
      "",
    ].join("\n"),
    "src/lib/components/ProfileCard.svelte": [
      '<script lang="ts">',
      '  import { goto } from "$app/navigation";',
      '  import { page } from "$app/state";',
      '  import { PUBLIC_REGION, PUBLIC_STORE_NAME } from "$app/env/public";',
      '  import { initials } from "#lib";',
      "",
      "  let { name }: { name: string } = $props();",
      "</script>",
      "",
      '<section class="profile-card">',
      '  <span class="avatar">{initials(name)}</span>',
      "  <h2>{name}</h2>",
      '  <p class="store">{PUBLIC_STORE_NAME} · {PUBLIC_REGION}</p>',
      '  <p class="path">{page.url.pathname}</p>',
      '  <button onclick={() => goto("/settings")}>Settings</button>',
      "</section>",
      "",
    ].join("\n"),
  });
  await linkProjectDependencies(worktree, dependencies.sveltekit3!.project);
}

// A Svelte 5 app bundled by Rollup, without Vite: its tsconfig.json maps
// @lib/ to src/lib/.
async function writeSvelteRollupFixture(worktree: string) {
  await writeFixtureFiles(worktree, {
    "package.json": JSON.stringify({
      name: "svelte-rollup-fixture",
      private: true,
      version: "1.0.0",
      type: "module",
      scripts: { build: "rollup -c", dev: "rollup -c -w" },
      devDependencies: {
        "@rollup/plugin-node-resolve": "^16.0.3",
        rollup: "^4.52.5",
        "rollup-plugin-svelte": "^7.2.3",
        svelte: "^5.57.3",
      },
    }),
    "rollup.config.js": [
      'import resolve from "@rollup/plugin-node-resolve";',
      'import svelte from "rollup-plugin-svelte";',
      "",
      "export default {",
      '  input: "src/main.ts",',
      '  output: { file: "public/build/bundle.js", format: "es" },',
      "  plugins: [svelte(), resolve({ browser: true })],",
      "};",
      "",
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        moduleResolution: "bundler",
        paths: { "@lib/*": ["./src/lib/*"] },
      },
    }),
    "src/global.css": ".page {\n  font-family: system-ui, sans-serif;\n}\n",
    "src/main.ts": [
      'import { mount } from "svelte";',
      'import "./global.css";',
      'import Counter from "./lib/Counter.svelte";',
      "",
      'mount(Counter, { target: document.body, props: { label: "Clicks" } });',
      "",
    ].join("\n"),
    "src/lib/format.ts": [
      "export function formatCount(count: number) {",
      '  return String(count).padStart(2, "0");',
      "}",
      "",
    ].join("\n"),
    "src/lib/Counter.svelte": [
      '<script lang="ts">',
      '  import { formatCount } from "./format";',
      "",
      "  let { label, start = 0 }: { label: string; start?: number } = $props();",
      "  let count = $state(start);",
      "  const doubled = $derived(count * 2);",
      "</script>",
      "",
      '<button class="counter" onclick={() => (count += 1)}>{label}: {formatCount(count)} ({doubled})</button>',
      "",
      "<style>",
      "  .counter {",
      "    border-radius: 9999px;",
      "  }",
      "</style>",
      "",
    ].join("\n"),
    "src/lib/counter.blame-preview.ts": [
      'import { mount as mountComponent } from "svelte";',
      'import "../global.css";',
      'import Counter from "@lib/Counter.svelte";',
      "",
      "const states: Record<string, { label: string; start?: number }> = {",
      '  default: { label: "Clicks", start: 3 },',
      '  empty: { label: "Clicks" },',
      "};",
      "",
      "export function mount(element: HTMLElement, state: string) {",
      "  mountComponent(Counter, { target: element, props: states[state] });",
      "}",
      "",
    ].join("\n"),
  });
  await linkProjectDependencies(worktree, dependencies.svelte!.project);
}

async function linkProjectDependencies(
  worktree: string,
  project: Record<string, string>,
) {
  for (const [name, directory] of Object.entries(project)) {
    await mkdir(dirname(join(worktree, "node_modules", name)), {
      recursive: true,
    });
    await symlink(directory, join(worktree, "node_modules", name), "dir");
  }
}

// Blame's own Vite, as the server would have installed it.
async function linkToolkit(
  root: string,
  framework: ComponentPreviewToolkit["framework"],
  toolkit: Record<string, string>,
) {
  const directory = toolkitDirectory(root, framework);
  for (const [name, source] of Object.entries(toolkit))
    await linkPackage(directory, name, source);
}

// Blame's own Vite with @sveltejs/vite-plugin-svelte and its dependencies,
// but no Svelte next to the plugin: it can only compile with the
// project's.
async function linkSvelteToolkit(
  root: string,
  toolkit: Record<string, string>,
) {
  const directory = toolkitDirectory(root, "svelte");
  const plugin = toolkit["@sveltejs/vite-plugin-svelte"]!;
  await linkPackage(directory, "vite", toolkit.vite!);
  await cp(
    plugin,
    join(directory, "node_modules/@sveltejs/vite-plugin-svelte"),
    {
      recursive: true,
    },
  );
  const manifest = createRequire(import.meta.url)(
    join(plugin, "package.json"),
  ) as { dependencies: Record<string, string> };
  // pnpm installs a package's dependencies next to it.
  for (const name of Object.keys(manifest.dependencies))
    await linkPackage(
      directory,
      name,
      realpathSync(join(plugin, "../..", name)),
    );
}

function toolkitDirectory(
  root: string,
  framework: ComponentPreviewToolkit["framework"],
) {
  const header =
    process.platform === "linux"
      ? (
          process.report.getReport() as {
            header?: { glibcVersionRuntime?: string };
          }
        ).header
      : undefined;
  const libc =
    process.platform !== "linux"
      ? ""
      : header?.glibcVersionRuntime
        ? "-gnu"
        : "-musl";
  const plugin = componentPreviewToolkitPlugin(framework);
  return join(
    root,
    `vite-${componentPreviewToolkitVersions.vite}-${plugin.name.replace(/^@[^/]+\//u, "")}-${plugin.version}-${process.platform}-${process.arch}${libc}`,
  );
}

async function linkPackage(directory: string, name: string, source: string) {
  await mkdir(dirname(join(directory, "node_modules", name)), {
    recursive: true,
  });
  await symlink(source, join(directory, "node_modules", name), "dir");
}

function packageVersion(directory: string) {
  return (
    createRequire(import.meta.url)(join(directory, "package.json")) as {
      version: string;
    }
  ).version;
}

type FixtureDependencies = {
  // Installed package folders, by package name.
  project: Record<string, string>;
  toolkit: Record<string, string>;
};

// Vite, @vitejs/plugin-vue, Vue, @sveltejs/vite-plugin-svelte, Svelte and
// SvelteKit 2 and 3 from the desktop package, @vitejs/plugin-react and
// React from the app package, Next.js and Tailwind from the vitrine
// package, jsdom from the agent-runtime package. A fixture whose packages
// are not all installed is skipped.
function resolveDependencies() {
  const packages = new URL("../../../../", import.meta.url);
  const installed = (packageName: string, name: string) => {
    const link = join(packages.pathname, packageName, "node_modules", name);
    return existsSync(join(link, "package.json"))
      ? realpathSync(link)
      : undefined;
  };
  const vite = installed("desktop", "vite");
  const svelte = {
    "@sveltejs/vite-plugin-svelte": installed(
      "desktop",
      "@sveltejs/vite-plugin-svelte",
    ),
    svelte: installed("desktop", "svelte"),
    vite,
  };
  const tailwind = {
    "@tailwindcss/postcss": installed("vitrine", "@tailwindcss/postcss"),
    tailwindcss: installed("vitrine", "tailwindcss"),
  };
  return {
    next: fixtureDependencies(
      {
        ...tailwind,
        next: installed("vitrine", "next"),
        react: installed("app", "react"),
        "react-dom": installed("app", "react-dom"),
      },
      {
        "@vitejs/plugin-react": installed("app", "@vitejs/plugin-react"),
        vite,
      },
    ),
    vue: fixtureDependencies(
      { ...tailwind, vue: installed("desktop", "vue") },
      {
        "@vitejs/plugin-vue": installed("desktop", "@vitejs/plugin-vue"),
        vite,
      },
    ),
    svelte: fixtureDependencies(
      { svelte: svelte.svelte },
      {
        "@sveltejs/vite-plugin-svelte": svelte["@sveltejs/vite-plugin-svelte"],
        vite,
      },
    ),
    // Their own Vite: nothing of Blame's.
    sveltekit2: fixtureDependencies(
      { ...svelte, "@sveltejs/kit": installed("desktop", "sveltekit-2") },
      {},
    ),
    sveltekit3: fixtureDependencies(
      { ...svelte, "@sveltejs/kit": installed("desktop", "@sveltejs/kit") },
      {},
    ),
    jsdom: installed("agent-runtime", "jsdom"),
  };
}

function fixtureDependencies(
  project: Record<string, string | undefined>,
  toolkit: Record<string, string | undefined>,
): FixtureDependencies | undefined {
  const installedProject = allInstalled(project);
  const installedToolkit = allInstalled(toolkit);
  return installedProject && installedToolkit
    ? { project: installedProject, toolkit: installedToolkit }
    : undefined;
}

function allInstalled(folders: Record<string, string | undefined>) {
  const entries = Object.entries(folders);
  return entries.every(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
    ? Object.fromEntries(entries)
    : undefined;
}
