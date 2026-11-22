# Preview campaign

Drives the **built desktop app** in an isolated profile through the workspace
API the story drawer uses, against real projects in a real Blame Runtime VM:
create a worktree, prepare the preview from a manifest, start it, follow its
lifecycle, load the page in a browser, edit files, stop, restart, hibernate,
crash the VM, remove. Each scenario records checks with timings.

It is a smoke and stress campaign for **Local Container** previews. Cloud
Preview needs a signed-in account and costs money: it is not driven here.

```sh
pnpm --filter @blame/desktop build:semantic-harness-payload   # payload = runtime version
pnpm --filter @blame/desktop exec electron-vite build
pnpm --filter @blame/api build
node scripts/preview-campaign/drive.mjs --out <dir> [--only a,b] [--fresh] [--keep]
```

- `--only` takes scenario or fixture names, or prefixes: `healthy`, `edge`,
  `failing`, `slow-start`, `lifecycle`, `port-taken`, `dependency`, `edits`,
  `review-build`, `parallel`, `app-restart`, `vm-crash`, `idle`,
  `runtime-sleep`, `remove`, `runtime`, or a fixture such as `next-app`.
  A scenario that needs a running story (`lifecycle`, `edits`, …) needs that
  story's fixture in the same `--only`.
- State lives under `/tmp/blc` (Lima sockets need a short path): the VM, the
  app profile, the images. `--fresh` deletes the VM and starts over. The
  fixtures are rebuilt in `~/.blame-campaign/projects` on each run (the VM only
  mounts the home folder).
- Needs `/Applications/Blame.app` of the **same runtime version** as the
  checkout: its Lima bundle runs the VM and its Lima config downloads the baked
  image (the repository's config builds from the plain Ubuntu image).
- Never touches the real `BlameRuntime` VM or the app's own data.
- Needs network (npm, Docker Hub). Run it on a quiet Mac, and with `caffeinate -i`
  for the long scenarios (`idle` waits 8 minutes, `runtime-sleep` up to 24).

`fixtures.mjs` holds the projects and the manifest an initialization agent
would write for each; `browse.mjs` is the throwaway browser that loads a
preview, reports console errors and failed requests, and sees a hot reload.
