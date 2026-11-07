---
name: component-preview
description: Use after creating a UI component or changing how one renders, in a Vite, React, Vue 3, Svelte 5 or Angular project (Next.js, Vue CLI, Nuxt, SvelteKit and Angular CLI included) or a React Native one with react-native-web (an Expo app with web support), even when the app's preview is available. Shows the component on its own with made-up data, in its main states (default, empty, error, loading, long content), light and dark, desktop and mobile widths, rendered in one open_component_preview call whose screenshots go to finish_task. Not for checks a DOM read or a test already covers.
---

# Component preview

Show one component on its own, with props and data you make up, rendered by a temporary Vite server that `open_component_preview` starts for the session: with the package's own Vite config, a SvelteKit app's included, or with Blame's own Vite for a React, Vue 3, Svelte 5 or Angular package without one, such as a Next.js, Vue CLI, Nuxt, Rollup or Angular CLI app, and for a React Native package with `react-native-web`, such as an Expo app. You avoid sign-in, the backend and real data, and see every state that matters in one call. The story's own preview, if any, keeps running untouched.

## When to use it

Use it by default whenever you create a UI component or change how one renders: layout, spacing, color, copy, states, theme or responsive behavior.

- **Component preview first**, even when the app's preview is available. It shows the states side by side, including those that are slow or impossible to reach in the app.
- **App captures as a complement, if you want them.** When the story also has a visual preview of the app (a managed preview, a Direct app, a screen or a device), you may also capture it with that preview's tools for what the component alone cannot show: a whole screen, a flow, where the component sits in its page, navigation between screens.
- **The app alone only when the component preview costs more than the app.** For example, the component needs heavy fakes (several providers, global state, real data) while the state you need shows directly in the app's preview; or the change is about how the screen integrates the component rather than how the component renders.
- **No visual preview of the app**, such as a native desktop app without a web service: the component preview is the visual check available. It shows the component, never the app window, so never claim you inspected the app.

## Write the preview file

Write one file, `<name>.blame-preview.tsx`, in the package of the component: the folder with its `package.json`. It is the only file to write: the server generates the page. The file imports the app's global stylesheet and the component, and exports each state as a React element; the state `default` is the default export:

```tsx
import "./index.css" // the app's global styles, Tailwind included
import { SettingsPanel } from "./components/settings-panel"

export default <SettingsPanel items={sampleItems} />
export const empty = <SettingsPanel items={[]} />
export const error = <SettingsPanel items={[]} error="The server did not answer." />
export const loading = <SettingsPanel items={[]} loading />
export const long = <SettingsPanel items={manyItemsWithLongNames} />
```

For Vue, Angular, Svelte or another framework, write `<name>.blame-preview.ts` and export `mount(element, state)` instead: it renders the named state into `element` with the framework's own entry API. For Vue, Svelte and Angular, see below.

The dark theme emulates `prefers-color-scheme` and sets the `dark` class, `data-theme` and `color-scheme` on `<html>`. If the project applies its theme another way, do it in the file.

## Next.js and other React packages without Vite

A React package without `vite.config.*`, such as a Next.js or webpack app, is served by Blame's own Vite with `@vitejs/plugin-react`. Its PostCSS or Tailwind config and the `paths` of its `tsconfig.json` (or `jsconfig.json`) apply, so `@/` imports work. Import the stylesheet its root layout imports, such as `app/globals.css`.

- `next/link`, `next/image`, `next/navigation` and `next/font/*` are small shims, in this server only: a link renders its anchor and does not navigate, an image loads from `public/` without optimization, `usePathname()` returns `/` and the router does nothing, a Google font keeps its class names with a fallback font. `NEXT_PUBLIC_*` variables of the `.env` files reach `process.env`.
- `"use client"` files render as they are.
- Only client components render. A Server Component (an async component, as most `page.tsx` and `layout.tsx` are, or one that imports `next/headers`, `server-only` or Node modules) is reported as such: preview its client sub-components with the props it would pass them, or check that screen in the app.

## React Native and Expo packages

A React Native package with `react-native-web`, such as an Expo app with web support, is served by Blame's own Vite with `@vitejs/plugin-react`, as its web build renders it: `react-native` resolves to `react-native-web`, a `.web.tsx` or `.web.ts` file comes before its native variant, `__DEV__` is `true` and the `EXPO_PUBLIC_*` variables of its `.env` files reach `process.env`. Write `<name>.blame-preview.tsx` as for React; the components keep their `View`, `Text`, `Pressable` and `StyleSheet`:

```tsx
import { ProfileCard } from "./components/profile-card"

export default <ProfileCard name="Ada Lovelace" status="Active" />
export const empty = <ProfileCard name="" status="" />
```

- Wrap the component in the providers it reads, such as `SafeAreaProvider` or a navigation container, with fake values.
- Without `react-native-web`, the package is not rendered: the tool says so. Check that component in the app or on a device; never add `react-native-web` or `react-dom` to the project only for the preview.
- An Expo module without a web implementation, whose native module or view the browser lacks, fails with an error that names it. Preview a sub-component that does not use it, pass what it gives through props, or check that component in the app or on a device.

## Vue 3 packages

A Vue 3 package (`vue` 3.2.25 or later) without `vite.config.*`, such as a Vue CLI or webpack app, is served by Blame's own Vite with `@vitejs/plugin-vue`. A package with a Vite config keeps its own. The preview file imports the `.vue` component and the stylesheet `src/main.*` imports, and mounts the requested state with `createApp(Component, props).mount(element)`:

```ts
import { createApp } from "vue"
import "@/assets/main.css" // the stylesheet src/main.ts imports
import ProfileCard from "@/components/ProfileCard.vue"

const states: Record<string, Record<string, unknown>> = {
  default: { name: "Ada Lovelace", status: "Active" },
  empty: { name: "", status: "" },
  long: { name: "Augusta Ada King, Countess of Lovelace", status: "Away" },
}

export function mount(element: HTMLElement, state: string) {
  createApp(ProfileCard, states[state]).mount(element)
}
```

- The component's `<style>` and `<style scoped>` blocks apply, and so do the package's PostCSS or Tailwind config and the `paths` of its `tsconfig.json` or `jsconfig.json`. In a Vue CLI package, `@/` resolves to `src/`, as in its webpack config. `VUE_APP_*` variables of its `.env` files reach `process.env`.
- Install what the component needs on the app before mounting, with fakes: `app.use(router)`, `app.use(createPinia())`, `app.provide(key, value)`.
- Vue 2 is not supported: the tool says so. Check that component in the app instead.

## Nuxt 3 and 4

A package that depends on `nuxt` 3 or 4 is served by Blame's own Vite with `@vitejs/plugin-vue` and what Nuxt generates at build time, in this server only. Write the preview file as for Vue, next to the component, and import the stylesheets of `nuxt.config`'s `css` field: the tool's first line lists them.

```ts
import { createApp } from "vue"
import "~/assets/css/main.css" // the stylesheets of nuxt.config's css field
import OrderSummary from "~/components/OrderSummary.vue"

const states: Record<string, Record<string, unknown>> = {
  default: { customer: "Ada Lovelace", items: sampleItems },
  empty: { customer: "Ada Lovelace", items: [] },
}

export function mount(element: HTMLElement, state: string) {
  createApp(OrderSummary, states[state]).mount(element)
}
```

- Auto-imports work as in Nuxt, in the preview file too: Vue's API (`ref`, `computed`, `watch`…), the exports of `composables/` and `utils/`, `#imports`, and the components of `components/` by their Nuxt names: `components/base/Button.vue` is `<BaseButton>`, a file of `components/global/` takes no prefix. `~/` and `@/` resolve to the `srcDir` (`app/` in Nuxt 4), `~~/` and `@@/` to the package.
- Nuxt's own components and composables are small shims. `<NuxtLink>` renders its anchor and does not navigate; `<NuxtImg>` and `<NuxtPicture>` (with `@nuxt/image`) load their source from `public/`; `<ClientOnly>` renders its content. `useRoute()` returns `/` with no params: to show another route, set it before mounting, such as `Object.assign(useRoute().params, { id: "42" })`. `useRouter()` and `navigateTo()` do nothing, `useHead()` and `useSeoMeta()` have no effect, `useRuntimeConfig()` returns the `public` part of `runtimeConfig` in `nuxt.config`, and `useState()` shares one ref per key.
- `useFetch`, `useAsyncData`, `$fetch` and imports of `server/` fail with a clear message, since the Nuxt server never runs: preview the component that receives the data through its props, and pass made-up data.
- The PostCSS plugins, `vite` plugins (such as `@tailwindcss/vite`) and aliases of `nuxt.config` apply. Nuxt modules that generate code at build time, such as `@nuxtjs/i18n` or `@pinia/nuxt`, do not: install what the component needs on the app before mounting, as for Vue.
- Nuxt 2 is not supported: the tool says so. Check that component in the app instead.

## SvelteKit and Svelte 5 packages

A SvelteKit app keeps its own Vite and `sveltekit()`, so `$lib` or `#lib`, its aliases, `$env/*` and `$app/env/*` work as in the app. SvelteKit's router does not run in the temporary page: `$app/state`, and `$app/stores` before SvelteKit 3, give a page at `/` with no params or data, its public environment variables reach the page, and `goto()` and links do not navigate. A Svelte 5 package (`svelte` 5.46.4 or later) without `vite.config.*`, such as a Rollup or webpack app, is served by Blame's own Vite with `@sveltejs/vite-plugin-svelte`: the package's own Svelte compiles its components, with its `svelte.config.*` if it has one.

The preview file imports the `.svelte` component and the stylesheet the root layout (or `src/main.*`) imports, and mounts the requested state with Svelte's `mount(Component, { target: element, props })`. The file's own export is named `mount`, so import Svelte's under another name:

```ts
import { mount as mountComponent } from "svelte"
import "../../app.css" // the stylesheet src/routes/+layout.svelte imports
import ProfileCard from "$lib/components/ProfileCard.svelte"

const states: Record<string, Record<string, unknown>> = {
  default: { name: "Ada Lovelace", status: "Active" },
  empty: { name: "", status: "" },
  long: { name: "Augusta Ada King, Countess of Lovelace", status: "Away" },
}

export function mount(element: HTMLElement, state: string) {
  mountComponent(ProfileCard, { target: element, props: states[state] })
}
```

- The component's `<style>` blocks apply, scoped as in the app, and so do the package's PostCSS or Tailwind config and, without Vite, the `paths` of its `tsconfig.json` or `jsconfig.json`.
- A component that reads the page: set it before mounting, such as `Object.assign(page, { url: new URL("/settings", location.href), params: { id: "42" } })` with `page` from `$app/state`. Pass layout data through props.
- A component that reads a context: pass `context: new Map([[key, value]])` to `mountComponent`.
- Server-only modules (`$lib/server/*`, `*.server.*`, private environment variables) never load in the browser: SvelteKit reports it. Preview the components that receive that data through props.
- Svelte 4 is not supported without a Vite config: the tool says so. Check that component in the app instead.

## Angular packages

An Angular 17 to 22 package without `vite.config.*`, with `@angular/build` or `@angular-devkit/build-angular`, such as an Angular CLI app, is served by Blame's own Vite with `@analogjs/vite-plugin-angular`. It compiles ahead of time with the project's own Angular compiler and the tsconfig `angular.json` names (`tsconfig.app.json`), as `ng serve` does. Write `<name>.blame-preview.ts` in a folder of the package, such as next to the component in `src/`. It imports each stylesheet of the `styles` field of `angular.json`, creates an application with the providers the component needs, then creates the component in `element` with the inputs of the requested state:

```ts
import "../../styles.css" // each stylesheet of "styles" in angular.json
import { createComponent } from "@angular/core"
import { createApplication } from "@angular/platform-browser"
import { provideRouter } from "@angular/router"
import { ProfileCardComponent } from "./profile-card.component"

const states: Record<string, Record<string, unknown>> = {
  default: { name: "Ada Lovelace", status: "Active" },
  empty: { name: "", status: "" },
  long: { name: "Augusta Ada King, Countess of Lovelace", status: "Away" },
}

export async function mount(element: HTMLElement, state: string) {
  const app = await createApplication({ providers: [provideRouter([])] })
  const card = createComponent(ProfileCardComponent, { environmentInjector: app.injector, hostElement: element })
  for (const [name, value] of Object.entries(states[state])) card.setInput(name, value)
  app.attachView(card.hostView)
  card.changeDetectorRef.detectChanges()
}
```

- `templateUrl`, `styleUrl` and `styleUrls` files, signal inputs, signals and control flow blocks render as in the app. `setInput` sets `input()` and `@Input()` inputs alike. The package's PostCSS config (such as `.postcssrc.json` with Tailwind) and the `paths` of its `tsconfig.json` apply.
- Pass the providers the component injects to `createApplication`, with fakes: `provideRouter([])` for a component that uses `routerLink`, `RouterOutlet`, `Router` or `ActivatedRoute`; `{ provide: UserService, useValue: fakeUsers }` for a service.
- zone.js loads before the preview file when the `polyfills` of `angular.json` include it; the tool's first line says so. Otherwise the render is zoneless: Angular 21 and later need nothing more, Angular 20 needs `provideZonelessChangeDetection()` in the providers, Angular 18 and 19 `provideExperimentalZonelessChangeDetection()`.
- A component an NgModule declares (`standalone: false`): import that module's file, add `importProvidersFrom(TheModule)` to the providers, and create the component with `createComponent` as above; `bootstrapApplication` only takes standalone components. When the module is missing, the tool names the elements Angular rendered nothing for.
- Angular 16 and earlier are not supported, nor server-side rendering: check that component in the app instead.

## Replace what the component depends on

The temporary page has no Electron preload, no signed-in API client and none of the app's providers. Replace them with fakes inside the preview file only:

- `window.*` globals and bridges the component reads: assign a small fake object before the states are rendered.
- API clients and data hooks: pass made-up data through props, or wrap the component in the project's context providers with fake values.
- Router, theme, i18n or query providers: wrap the component with the real provider and a fake value when it needs one.

Never change the project's real source to make the preview work. If the fakes grow heavy (several providers, global state, real data) and the app's preview shows the state directly, check it there instead. If the component cannot render without a deep change, say so and check the app.

## Keep the pass short

Choose the renders that answer the question, at most 6 in one call:

- The states that matter for this component: `default`, then `empty`, `error`, `loading` or long content when they apply.
- `dark` next to `light` only if the theme changes the rendering.
- A mobile width such as 390 next to the default 1280 only if the component is responsive.

## Check, then look

1. Call `open_component_preview` with `file`, the `states`, and the `themes` and `widths` that matter. One call renders every combination of states × themes × widths, at most 6, and returns one screenshot per render.
2. Read what each render reports: an error overlay, a reported error or console errors mean it is broken. Fix the preview file or the component, then call again: the same server shows the change.
3. Use the screenshots for what is visual: layout, spacing, color, contrast, overflow. `preview_devtools__take_snapshot` and the other `preview_devtools__*` tools still drive the story's own preview, not this render.

## Finish

Attach the useful screenshots to `finish_task` with `images`, using the `screenshot:<id>` references from the results. Screenshots of the isolated component and of the app can be mixed: each one-line caption says which of the two it shows, such as "Isolated component: empty state, dark" or "App: settings page with the new panel". The temporary files are ignored by Git and removed when the task finishes; the screenshots stay available.