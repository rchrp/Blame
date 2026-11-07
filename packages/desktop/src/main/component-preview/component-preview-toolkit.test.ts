import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workspaceComponentPreviewHost } from "./component-preview-hosts.ts";
import {
  componentPreviewToolkitFolder,
  componentPreviewToolkitVersions,
  type ComponentPreviewToolkit,
} from "./component-preview-server-script.ts";
import {
  ComponentPreviewService,
  type ComponentPreviewCapture,
  type ComponentPreviewPage,
} from "./component-preview-service.ts";

// A small Next.js App Router project, a small Vue CLI project and a small
// Nuxt 4 project, without Vite, rendered by the real temporary server with
// Blame's own Vite and @vitejs/plugin-react or @vitejs/plugin-vue, with
// unimport for Nuxt. The browser is replaced by requests for the page and
// the modules it loads.

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
      dependencies.next && dependencies.vue && dependencies.nuxt
        ? false
        : "Vite, @vitejs/plugin-react, @vitejs/plugin-vue or unimport is not installed for the desktop tests.",
  },
  () => {
    assert.deepEqual(
      {
        pluginReact: packageVersion(
          dependencies.next!.toolkit["@vitejs/plugin-react"]!,
        ),
        pluginVue: packageVersion(
          dependencies.vue!.toolkit["@vitejs/plugin-vue"]!,
        ),
        unimport: packageVersion(dependencies.nuxt!.toolkit.unimport!),
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
  "a Nuxt component renders with Blame's Vite: auto-imports, components by their Nuxt names, the Nuxt shims and Tailwind from nuxt.config",
  {
    skip: dependencies.nuxt
      ? false
      : "Vite, @vitejs/plugin-vue, unimport, Vue or Tailwind is not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), "blame-component-preview-nuxt-"),
    );
    const toolkitRoot = await mkdtemp(
      join(tmpdir(), "blame-component-preview-toolkit-"),
    );
    const responses = new Map<string, string>();
    let service: ComponentPreviewService | undefined;
    try {
      await writeNuxtFixture(worktree);
      const toolkitDirectory = await linkToolkit(
        toolkitRoot,
        "nuxt",
        dependencies.nuxt!.toolkit,
      );
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
        // The preview file and every module it loads: components,
        // composables, utils and shims.
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
          toolkit: { framework: "nuxt" },
        }),
        storeScreenshots: async (result) => ({
          ...(result as object),
          _meta: { blameScreenshots: [{ id: "3".repeat(64) }] },
        }),
      });
      const result = (await service.render({
        request: { file: "app/components/profile.blame-preview.ts" },
        worktree,
      })) as {
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.match(
        result.content[0]!.text!,
        /^Started Blame's own Vite 8\.\d+\.\d+ server with @vitejs\/plugin-vue, Nuxt's auto-imports and shims for <NuxtLink>, @nuxt\/image, useRoute, useRouter, navigateTo, useHead, useRuntimeConfig and useState, in the story's workspace for the worktree root, at http:\/\/127\.0\.0\.1:\d+: the package has no Vite config, so its nuxt\.config and PostCSS config apply\. ~\/ and @\/ resolve to app\/\. Its nuxt\.config's css field lists ~\/assets\/css\/main\.css: import it in the preview file\. 1 render of app\/components\/profile\.blame-preview\.ts:$/u,
      );

      // ~ resolves to Nuxt 4's srcDir, app/; Vue comes from the project,
      // bundled up front.
      const preview = responses.get(
        "/app/components/profile.blame-preview.ts",
      )!;
      assert.match(preview, /from "\/app\/components\/ProfileCard\.vue"/u);
      assert.match(preview, /import "\/app\/assets\/css\/main\.css"/u);
      assert.match(preview, /\.vite-blame-preview-[0-9a-f]+\/deps\/vue\.js/u);

      // Nothing is imported in ProfileCard.vue: Vue's API and the Nuxt
      // composables come from the shims, useGreeting from composables/,
      // formatPrice (in the template) from utils/, and the components by
      // their Nuxt names: base/Button.vue is <BaseButton>, global/ files
      // take no prefix. Nuxt's flags are constants in the browser.
      const card = responses.get("/app/components/ProfileCard.vue")!;
      assert.doesNotMatch(card, /resolveComponent\("/u);
      for (const source of [
        "/@id/__x00__blame-nuxt:app",
        "/@id/__x00__blame-nuxt:components",
        "/app/components/base/Button.vue",
        "/app/components/global/StatusBadge.vue",
        "/app/composables/useGreeting.ts",
        "/app/utils/format.ts",
      ])
        assert.ok(
          card.includes(`from "${source}"`),
          `${source} is not imported:\n${card}`,
        );
      assert.match(card, /\{ NuxtLink as __blame_nuxt_component_\d+ \}/u);
      assert.match(card, /\{ NuxtImg as __blame_nuxt_component_\d+ \}/u);
      for (const name of ["useRoute", "useRuntimeConfig", "useState"])
        assert.match(
          card,
          new RegExp(
            `import \\{[^}]*\\b${name}\\b[^}]*\\} from "/@id/__x00__blame-nuxt:app"`,
            "u",
          ),
        );
      assert.doesNotMatch(card, /import\.meta\.client/u);
      // An explicit #imports import gets its real source.
      const button = responses.get("/app/components/base/Button.vue")!;
      assert.doesNotMatch(button, /#imports/u);
      assert.match(button, /\.vite-blame-preview-[0-9a-f]+\/deps\/vue\.js/u);
      // Nuxt's tsconfig.json references .nuxt/, which nuxi has not written:
      // Blame's stands in for it, and TypeScript modules still compile.
      // Vue's API is auto-imported in composables too.
      const greeting = responses.get("/app/composables/useGreeting.ts")!;
      assert.match(greeting, /export function useGreeting\(name\)/u);
      assert.match(
        greeting,
        /import \{ computed \} from "\/node_modules\/\.vite-blame-preview-[0-9a-f]+\/deps\/vue\.js/u,
      );
      assert.equal(
        existsSync(join(toolkitDirectory, "nuxt-tsconfig.json")),
        true,
      );

      // The shims: useRuntimeConfig() has the public part of nuxt.config's
      // runtimeConfig only; useFetch and $fetch say what to do instead.
      const app = responses.get("/@id/__x00__blame-nuxt:app")!;
      for (const name of [
        "useRoute",
        "useRouter",
        "navigateTo",
        "useHead",
        "useSeoMeta",
        "useRuntimeConfig",
        "useState",
        "useFetch",
        "useAsyncData",
        "$fetch",
      ])
        assert.ok(
          app.includes(`export function ${name}(`) ||
            app.includes(`export const ${name} =`),
          `${name} is not shimmed:\n${app}`,
        );
      assert.match(app, /"siteName":"Fixture shop"/u);
      assert.doesNotMatch(app, /never-in-the-page/u);
      assert.match(
        app,
        /fetches data from the Nuxt server, which open_component_preview does not run: " \+ "pass made-up data to the component through its props instead\."/u,
      );
      const components = responses.get("/@id/__x00__blame-nuxt:components")!;
      assert.match(components, /export const NuxtLink = /u);
      assert.match(components, /h\("a", /u);
      assert.match(components, /export const NuxtImg = /u);
      assert.match(
        components,
        /\.vite-blame-preview-[0-9a-f]+\/deps\/vue\.js/u,
      );

      // A component that fetches its data imports useFetch from the shims;
      // one that imports server/ fails with a clear message.
      const orders = await (
        await fetch(new URL("/app/components/OrderList.vue", page.origin))
      ).text();
      assert.match(
        orders,
        /import \{[^}]*\buseFetch\b[^}]*\} from "\/@id\/__x00__blame-nuxt:app"/u,
      );
      const admin = await (
        await fetch(new URL("/app/components/AdminStats.vue", page.origin))
      ).text();
      const serverImport = /"(\/@id\/__x00__blame-nuxt:server:\d+)"/u.exec(
        admin,
      )?.[1];
      assert.ok(serverImport, admin);
      assert.match(
        await (await fetch(new URL(serverImport, page.origin))).text(),
        /throw new Error\("app\/components\/AdminStats\.vue imports server\/utils\/stats, which is part of the Nuxt server and never runs in the browser: pass made-up data to the component through its props instead\."\)/u,
      );

      // Tailwind runs through the PostCSS plugins of nuxt.config, on the
      // .vue files of app/; images come from public/.
      const css = await (
        await fetch(new URL("/app/assets/css/main.css?direct", page.origin))
      ).text();
      assert.match(css, /\.bg-emerald-600\s*\{/u);
      assert.match(css, /\.rounded-xl\s*\{/u);
      const avatar = await fetch(new URL("/avatar.png", page.origin));
      assert.equal(avatar.status, 200);
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
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(worktree, path)), { recursive: true });
    await writeFile(join(worktree, path), content);
  }
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
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(worktree, path)), { recursive: true });
    await writeFile(join(worktree, path), content);
  }
  await linkProjectDependencies(worktree, dependencies.vue!.project);
}

// A Nuxt 4 app as create-nuxt writes it, before nuxi prepare: no .nuxt/,
// so its tsconfig.json references files that do not exist yet. Its
// components use auto-imports only; Tailwind comes from the PostCSS plugins
// of nuxt.config. Nuxt itself is not installed: the preview never loads it.
async function writeNuxtFixture(worktree: string) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "nuxt-fixture",
      private: true,
      type: "module",
      scripts: { dev: "nuxt dev" },
      dependencies: {
        "@nuxt/image": "^1.11.0",
        nuxt: "^4.2.0",
        vue: "^3.5.45",
        "vue-router": "^4.6.3",
      },
      devDependencies: {
        "@tailwindcss/postcss": "4.3.3",
        tailwindcss: "4.3.3",
      },
    }),
    "tsconfig.json": JSON.stringify({
      files: [],
      references: [
        { path: "./.nuxt/tsconfig.app.json" },
        { path: "./.nuxt/tsconfig.server.json" },
        { path: "./.nuxt/tsconfig.shared.json" },
        { path: "./.nuxt/tsconfig.node.json" },
      ],
    }),
    "nuxt.config.ts": [
      "export default defineNuxtConfig({",
      '  compatibilityDate: "2026-11-01",',
      '  modules: ["@nuxt/image"],',
      '  css: ["~/assets/css/main.css"],',
      '  postcss: { plugins: { "@tailwindcss/postcss": {} } },',
      "  runtimeConfig: {",
      '    apiSecret: "never-in-the-page",',
      '    public: { siteName: "Fixture shop" },',
      "  },",
      "});",
      "",
    ].join("\n"),
    "app/app.vue": "<template><NuxtPage /></template>\n",
    "app/assets/css/main.css": '@import "tailwindcss";\n',
    "app/composables/useGreeting.ts": [
      "export function useGreeting(name: string) {",
      '  return computed(() => "Hello, " + name);',
      "}",
      "",
    ].join("\n"),
    "app/utils/format.ts": [
      "export function formatPrice(cents: number): string {",
      '  return (cents / 100).toFixed(2) + " €";',
      "}",
      "",
    ].join("\n"),
    "app/components/base/Button.vue": [
      "<template>",
      '  <NuxtLink :to="href" class="base-button rounded-full bg-white px-3 py-1 text-emerald-700"><slot /></NuxtLink>',
      "</template>",
      "",
      '<script setup lang="ts">',
      'import { computed } from "#imports";',
      "",
      "const props = defineProps<{ to: string }>();",
      "const href = computed(() => props.to);",
      "</script>",
      "",
      "<style scoped>",
      ".base-button {",
      "  letter-spacing: 0.05em;",
      "}",
      "</style>",
      "",
    ].join("\n"),
    "app/components/global/StatusBadge.vue": [
      "<template>",
      '  <span class="rounded-full bg-white/20 px-2 text-xs">{{ label }}</span>',
      "</template>",
      "",
      "<script setup>",
      "defineProps({ label: String });",
      "</script>",
      "",
    ].join("\n"),
    "app/components/ProfileCard.vue": [
      "<template>",
      '  <section class="rounded-xl bg-emerald-600 p-6 text-white">',
      '    <NuxtImg src="/avatar.png" width="48" height="48" alt="" />',
      '    <h2 class="text-2xl font-bold">{{ greeting }}</h2>',
      "    <p>{{ config.public.siteName }} · {{ route.path }} · {{ formatPrice(totalCents) }} · {{ visits }}</p>",
      '    <StatusBadge :label="status" />',
      "    <NuxtLink :to=\"{ path: '/orders', query: { tab: 'open' } }\" class=\"underline\">Orders</NuxtLink>",
      '    <BaseButton to="/settings">Settings</BaseButton>',
      '    <p v-if="client">Rendered in the browser</p>',
      "  </section>",
      "</template>",
      "",
      '<script setup lang="ts">',
      "const props = defineProps<{ name: string; status: string; totalCents: number }>();",
      "const route = useRoute();",
      "const config = useRuntimeConfig();",
      'const visits = useState("visits", () => 3);',
      "const greeting = useGreeting(props.name);",
      "const client = import.meta.client;",
      "</script>",
      "",
    ].join("\n"),
    "app/components/OrderList.vue": [
      "<template>",
      '  <ul><li v-for="order in data" :key="order.id">{{ order.id }}</li></ul>',
      "</template>",
      "",
      "<script setup>",
      'const { data } = await useFetch("/api/orders");',
      "</script>",
      "",
    ].join("\n"),
    "app/components/AdminStats.vue": [
      "<template>",
      "  <p>{{ stats.orders }}</p>",
      "</template>",
      "",
      "<script setup>",
      'import { stats } from "~~/server/utils/stats";',
      "</script>",
      "",
    ].join("\n"),
    "server/utils/stats.ts": "export const stats = { orders: 12 };\n",
    // Next to the component, where the agent writes it: Nuxt's scanner
    // never takes it for a component.
    "app/components/profile.blame-preview.ts": [
      'import { createApp } from "vue";',
      'import "~/assets/css/main.css";',
      'import ProfileCard from "~/components/ProfileCard.vue";',
      "",
      "const states: Record<string, Record<string, unknown>> = {",
      '  default: { name: "Ada Lovelace", status: "Active", totalCents: 4200 },',
      "};",
      "",
      "export function mount(element: HTMLElement, state: string) {",
      "  createApp(ProfileCard, states[state]).mount(element);",
      "}",
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(worktree, path)), { recursive: true });
    await writeFile(join(worktree, path), content);
  }
  await mkdir(join(worktree, "public"), { recursive: true });
  await writeFile(join(worktree, "public/avatar.png"), png);
  await linkProjectDependencies(worktree, dependencies.nuxt!.project);
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

// Blame's own Vite, as the server would have installed it. Returns its
// folder.
async function linkToolkit(
  root: string,
  framework: ComponentPreviewToolkit["framework"],
  toolkit: Record<string, string>,
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
  const directory = join(
    root,
    `${componentPreviewToolkitFolder(framework)}-${process.platform}-${process.arch}${libc}`,
  );
  for (const [name, source] of Object.entries(toolkit)) {
    await mkdir(dirname(join(directory, "node_modules", name)), {
      recursive: true,
    });
    await symlink(source, join(directory, "node_modules", name), "dir");
  }
  return directory;
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

// Vite, @vitejs/plugin-vue, unimport and Vue from the desktop package,
// @vitejs/plugin-react and React from the app package, Next.js and
// Tailwind from the vitrine package. A fixture whose packages are not all
// installed is skipped.
function resolveDependencies() {
  const packages = new URL("../../../../", import.meta.url);
  const installed = (packageName: string, name: string) => {
    const link = join(packages.pathname, packageName, "node_modules", name);
    return existsSync(join(link, "package.json"))
      ? realpathSync(link)
      : undefined;
  };
  const vite = installed("desktop", "vite");
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
    nuxt: fixtureDependencies(
      { ...tailwind, vue: installed("desktop", "vue") },
      {
        "@vitejs/plugin-vue": installed("desktop", "@vitejs/plugin-vue"),
        unimport: installed("desktop", "unimport"),
        vite,
      },
    ),
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
