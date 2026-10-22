---
name: component-preview
description: Use to check a component, screen or hard-to-reach state visually without running the whole app — errors, loading, empty or very long lists, dark mode, mobile widths — when the story has a managed preview. Shows the component alone on a temporary page with made-up data, served by the project's dev server, opened with open_component_preview. Not for checks a DOM read or a test already covers.
---

# Component preview

Show one component on its own, with props and data you make up, on a temporary page that the project's dev server already running in the managed preview serves. You avoid sign-in, the backend and real data, and you can reach states that are hard to produce in the full app.

## When to use it

- A visual change to a component or screen you want to look at before finishing.
- A state that is hard to reach in the app: an error, a loading state, an empty list, a very long list or long text, a permission variant.
- The same component in light and dark mode, or at a mobile width.

Prefer the real app through `preview_devtools__*` when the page is easy to reach. Use a component preview when it is not.

## Pick the recipe from the project's files

Check `package.json`, the dev server configuration and the folder layout first.

### Vite (React, Vue, Svelte)

Create two files at the root that Vite serves (the folder of `vite.config.*` or its `root`):

- `<name>.blame-preview.html`, a minimal page that loads the module below:

  ```html
  <!doctype html>
  <html lang="en">
    <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
    <body><div id="root"></div><script type="module" src="./<name>.blame-preview.tsx"></script></body>
  </html>
  ```

- `<name>.blame-preview.tsx` (or `.ts`), which imports the project's global stylesheet, mounts the component with made-up props, and reads the query string to switch between states:

  ```tsx
  import "./src/index.css" // the project's global styles
  import { createRoot } from "react-dom/client"
  import { SettingsPanel } from "./src/components/settings-panel"

  const params = new URLSearchParams(location.search)
  // Apply the theme the way the project does: a class, a data attribute…
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
  const states = {
    default: { items: sampleItems },
    empty: { items: [] },
    error: { items: [], error: "The server did not answer." },
  }
  const state = states[(params.get("state") ?? "default") as keyof typeof states]
  createRoot(document.getElementById("root")!).render(<SettingsPanel {...state} />)
  ```

Open it with `open_component_preview` and `path: "/<name>.blame-preview.html?state=empty&theme=dark"`. For Vue or Svelte, mount the component with the framework's own entry API in the same way.

### Next.js App Router

Create `app/blame-preview/<name>/page.tsx` (under `src/app/` when the project uses it). Add `"use client"` at the top when the component uses state, effects or browser APIs. Read `searchParams` to switch states. Open `/blame-preview/<name>?state=empty`.

### Anything else

Look for an existing equivalent: Storybook stories, a playground, a dev-only route. If there is none the dev server can serve, say that a component preview is not available for this project and check the full app instead.

## Replace what the component depends on

The temporary page has no Electron preload, no signed-in API client and none of the app's providers. Replace them with fakes inside the temporary files only:

- `window.*` globals and bridges the component reads: assign a small fake object before mounting.
- API clients and data hooks: pass made-up data through props, or wrap the component in the project's context providers with fake values.
- Router, theme, i18n or query providers: wrap the component with the real provider and a fake value when it needs one.

Never change the project's real source to make the preview work. If the component cannot render without a deep change, report that and check the full app instead.

## Check, then look

1. Call `open_component_preview` with the path, and `colorScheme` or `viewport` when they matter. It refuses paths outside the temporary names and fails when the managed preview is not ready.
2. Read what it reports: an error overlay or console errors mean the page is broken. Fix the temporary page or the component, then open it again.
3. Check anything that can be read as text with `preview_devtools__take_snapshot`: labels, counts, disabled states, accessible names. Use the screenshot only for what is visual: layout, spacing, color, contrast, overflow.
4. Switch states with the query string and take one screenshot per state that matters, in light and dark when the change affects both.

## Finish

Attach the useful screenshots to `finish_task` with `images` and a one-line caption each, using the `screenshot:<id>` references from the results. The temporary files are ignored by Git and removed when the task finishes; the screenshots stay available.
