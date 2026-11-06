---
name: component-preview
description: Use after creating a UI component or changing how one renders, in a Vite project, even when the app's preview is available. Shows the component on its own with made-up data, in its main states (default, empty, error, loading, long content), light and dark, desktop and mobile widths, rendered in one open_component_preview call whose screenshots go to finish_task. Not for checks a DOM read or a test already covers.
---

# Component preview

Show one component on its own, with props and data you make up, rendered by a temporary Vite server that `open_component_preview` starts for the session with the package's own Vite config. You avoid sign-in, the backend and real data, and see every state that matters in one call. The story's own preview, if any, keeps running untouched.

## When to use it

Use it by default whenever you create a UI component or change how one renders: layout, spacing, color, copy, states, theme or responsive behavior.

- **Component preview first**, even when the app's preview is available. It shows the states side by side, including those that are slow or impossible to reach in the app.
- **App captures as a complement, if you want them.** When the story also has a visual preview of the app (a managed preview, a Direct app, a screen or a device), you may also capture it with that preview's tools for what the component alone cannot show: a whole screen, a flow, where the component sits in its page, navigation between screens.
- **The app alone only when the component preview costs more than the app.** For example, the component needs heavy fakes (several providers, global state, real data) while the state you need shows directly in the app's preview; or the change is about how the screen integrates the component rather than how the component renders.
- **No visual preview of the app**, such as a native desktop app without a web service: the component preview is the visual check available. It shows the component, never the app window, so never claim you inspected the app.

Packages without Vite, such as a Next.js app, have no component preview: check them in the app.

## Write the preview file

Write one file, `<name>.blame-preview.tsx`, in the package of the component: the folder with its `package.json` and `vite.config.*`. It is the only file to write: the server generates the page. The file imports the app's global stylesheet and the component, and exports each state as a React element; the state `default` is the default export:

```tsx
import "./index.css" // the app's global styles, Tailwind included
import { SettingsPanel } from "./components/settings-panel"

export default <SettingsPanel items={sampleItems} />
export const empty = <SettingsPanel items={[]} />
export const error = <SettingsPanel items={[]} error="The server did not answer." />
export const loading = <SettingsPanel items={[]} loading />
export const long = <SettingsPanel items={manyItemsWithLongNames} />
```

For Vue, Svelte or another framework, export `mount(element, state)` instead: it renders the named state into `element` with the framework's own entry API.

The dark theme emulates `prefers-color-scheme` and sets the `dark` class, `data-theme` and `color-scheme` on `<html>`. If the project applies its theme another way, do it in the file.

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