# Preview campaign

Drives the **built desktop app** in an isolated profile through the workspace
API the story drawer uses, against real projects in a real Blame Runtime VM:
create a worktree, prepare the preview from a manifest, start it, follow its
lifecycle, load the page in a browser, edit files, stop, restart, hibernate,
crash the VM, remove. Each scenario records checks with timings.

It is a smoke and stress campaign for **Local Container** previews. With
`--cloud` it also runs a few **Cloud Preview** sessions against the production
API (see below): they cost money and touch the signed-in account.

```sh
pnpm --filter @blame/desktop build:semantic-harness-payload   # payload = runtime version
pnpm --filter @blame/desktop exec electron-vite build
pnpm --filter @blame/api build
node scripts/preview-campaign/drive.mjs --out <dir> [--only a,b] [--fresh] [--keep]
```

- `--only` takes scenario or fixture names, or prefixes: `healthy`, `edge`,
  `failing`, `slow-start`, `lifecycle`, `port-taken`, `dependency`, `edits`,
  `review-build`, `parallel`, `app-restart`, `vm-crash`, `idle`,
  `runtime-sleep`, `remove`, `runtime`, `shared-setup`, or a fixture such as
  `next-app`.
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

`shared-setup` starts two stories of the same project one after the other
(plain Vite, Nuxt, Nuxt with a `postinstall`, a setup that writes a file the
server needs, a database, a failing install), then changes and removes the
shared `node_modules` volume. The second story of a project whose setup only
fills the volume must skip the install; every other kind must run it. Run it
with and without `BLAME_PREVIEW_SHARED_SETUP=0` to compare
`dependencies.install` (`shared-setup.json` in `--out`).

`fixtures.mjs` holds the projects and the manifest an initialization agent
would write for each; `browse.mjs` is the throwaway browser that loads a
preview, reports console errors and failed requests, and sees a hot reload.

## Cloud Preview (`--cloud`)

```sh
node scripts/preview-campaign/drive.mjs --cloud --out <dir> [--only vite-react,next-app,express-postgres,go-http,crash-on-start]
```

Creates, for each fixture, a story `[campaign] cloud <name>` in the account of
the installed app, uploads the fixture to a Vercel sandbox, starts it, opens it
in the test browser through an access ticket, edits a file locally and waits
for the edit in the open page, stops and restarts it, then destroys the
sandbox and deletes the story (also when a check fails). An empty project
`[campaign] preview tests` stays in the account (no delete route).

How it signs in: only the `Local Storage` of the installed app
(`~/Library/Application Support/dev.blame.desktop`, `--session-from`) is copied
to a profile of its own, then reduced to the account session key by a page of
its own, so the token never reaches the script. Copying everything makes the
app reopen the person's own workspace and its real stories: the run stops if a
workspace window opens. The copy is deleted at the end. The app talks to
`https://api.blame.so` because it is a production build.
