---
name: component-preview
description: Use to check a component, screen or hard-to-reach state visually without running the whole app — errors, loading, empty or very long lists, dark mode, mobile widths — in a Vite project. Shows the component alone with made-up data, rendered by the temporary Vite server that open_component_preview starts. Not for checks a DOM read or a test already covers.
---

# Component preview

Show one component on its own, with props and data you make up, rendered by a temporary Vite server that `open_component_preview` starts for the session with the package's own Vite config. You avoid sign-in, the backend and real data, and you can reach states that are hard to produce in the full app. The story's own preview, if any, keeps running untouched.

## When to use it

- A visual change to a component or screen you want to look at before finishing.
- A state that is hard to reach in the app: an error, a loading state, an empty list, a very long list or long text, a permission variant.
- The same component in light and dark mode, or at a mobile width.

Prefer the real app through `preview_devtools__*` when the page is easy to reach. Use a component preview when it is not.

## Write the preview file

Write one file, `<name>.blame-preview.tsx`, in the package of the component: the folder with its `package.json` and `vite.config.*`. No HTML page or route: the server generates them. The file imports the app's global stylesheet and the component, and exports each state as a React element; the state `default` is the default export:

```tsx
import "./index.css" // the app's global styles, Tailwind included
import { SettingsPanel } from "./components/settings-panel"

export default <SettingsPanel items={sampleItems} />
export const empty = <SettingsPanel items={[]} />
export const error = <SettingsPanel items={[]} error="The server did not answer." />
```

For Vue, Svelte or another framework, export `mount(element, state)` instead: it renders the named state into `element` with the framework's own entry API.

The dark theme emulates `prefers-color-scheme` and sets the `dark` class, `data-theme` and `color-scheme` on `<html>`. If the project applies its theme another way, do it in the file.

Projects without Vite, such as Next.js, have no component preview yet: check the full app instead.

## Replace what the component depends on

The temporary page has no Electron preload, no signed-in API client and none of the app's providers. Replace them with fakes inside the temporary files only:

- `window.*` globals and bridges the component reads: assign a small fake object before mounting.
- API clients and data hooks: pass made-up data through props, or wrap the component in the project's context providers with fake values.
- Router, theme, i18n or query providers: wrap the component with the real provider and a fake value when it needs one.

Never change the project's real source to make the preview work. If the component cannot render without a deep change, report that and check the full app instead.

## Check, then look

1. Call `open_component_preview` with `file`, the `states` to render, and the `themes` and `widths` that matter. One call renders every combination, at most 6, and returns one screenshot per render.
2. Read what each render reports: an error overlay, a reported error or console errors mean it is broken. Fix the preview file or the component, then call again: the same server shows the change.
3. Use the screenshots for what is visual: layout, spacing, color, contrast, overflow. `preview_devtools__take_snapshot` and the other `preview_devtools__*` tools still drive the story's own preview, not this render.

## Finish

Attach the useful screenshots to `finish_task` with `images` and a one-line caption each, using the `screenshot:<id>` references from the results. The temporary files are ignored by Git and removed when the task finishes; the screenshots stay available.
