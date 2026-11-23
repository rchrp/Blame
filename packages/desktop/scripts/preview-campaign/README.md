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
node packages/desktop/scripts/preview-campaign/drive.mjs --out <dir> [--only a,b] [--fresh] [--keep]
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
- Quitting the app stops the VM a few seconds to a minute later. A second `drive.mjs` started right after
  can find the VM `Running` while it shuts down: its first worktree then fails (`git branch --show-current`),
  or the run stalls (the app's runtime agent then logs `ERR_STREAM_WRITE_AFTER_END`). Between two runs wait
  for `limactl list` to say `Stopped`. `--only runtime` also selects `runtime-sleep` (about 18 minutes).
- Needs network (npm, Docker Hub). Run it on a quiet Mac, and with `caffeinate -i`
  for the long scenarios (`idle` waits 8 minutes, `runtime-sleep` up to 24).

`shared-setup` starts two stories of the same project one after the other
(plain Vite, Nuxt, Nuxt with a `postinstall`, an install followed by a command
that writes a file the server needs, a database, a failing install), then changes and removes the
shared `node_modules` volume. The second story of a project whose setup only
fills the volume must skip the install; every other kind must run it. Run it
with and without `BLAME_PREVIEW_SHARED_SETUP=0` to compare
`dependencies.install` (`shared-setup.json` in `--out`).

`fixtures.mjs` holds the projects and the manifest an initialization agent
would write for each; `browse.mjs` is the throwaway browser that loads a
preview, reports console errors and failed requests, and sees a hot reload.

## Advanced Local Container scenarios

```sh
cargo build -p blame-engine -p blame-harness
pnpm --filter @blame/desktop build
node packages/desktop/scripts/preview-campaign/drive.mjs \
  --root /tmp/blcx --projects "$HOME/.blame-campaign/advanced-projects" \
  --out out/preview-campaign-advanced --scripted-agents \
  --only runtime,advanced,lifecycle,isolation,migration-recovery,remove
```

- `django-celery` installs Python dependencies, migrates PostgreSQL and starts
  a Celery worker. The browser submits a job through Django and waits for the
  worker to record its result in PostgreSQL. `isolation` compares two live
  stories of the project after the first story has run the job, received an
  edit and restarted. `migration-recovery` breaks the Django settings in a
  fresh worktree, checks that setup fails, restores the settings and restarts
  the same story.
- `vite-fastapi-ws` installs dependencies in two subdirectories, sends a
  WebSocket message from React through Vite to FastAPI, and checks that a
  source edit reaches the open page without a manual reload.
- `rust-axum-sqlite` compiles a nested Cargo workspace with bundled SQLite,
  seeds the database and opens the configured `/reports/summary` route.

Each advanced fixture checks the desktop's embedded preview state and its
rendered content in a separate Chromium window. The `runtime` selector installs
and starts the VM when using a new `--root`.

`--scripted-agents` uses the built Blame engine and harness with a loopback
model and API that return preset tool calls. The initialization task scans
the project and validates the submitted preview setup before the campaign
uses it. In cloud mode the story agent also applies the source edit via
`edit_code`. This exercises the agent and synchronization paths with
repeatable input and no paid model calls.

## Cloud Preview (`--cloud`)

```sh
node packages/desktop/scripts/preview-campaign/drive.mjs --cloud --out <dir> [--only vite-react,next-app,express-postgres,go-http,crash-on-start]
```

Creates, for each fixture, a story `[campaign] cloud <name>` in the account of
the installed app, uploads the fixture to a Vercel sandbox, starts it, opens it
in the test browser through an access ticket, edits a file locally and waits
for the edit in the open page, stops and restarts it, then destroys the
sandbox and deletes the story (also when a check fails). An empty project
`[campaign] preview tests` stays in the account (no delete route).

To run one cloud session through React hydration, an agent edit and a restart:

```sh
node packages/desktop/scripts/preview-campaign/drive.mjs --cloud --scripted-agents \
  --root /tmp/blc-cloud --projects "$HOME/.blame-campaign/cloud-projects" \
  --out out/preview-campaign-cloud --only next-app
```

How it signs in: only the `Local Storage` of the installed app
(`~/Library/Application Support/dev.blame.desktop`, `--session-from`) is copied
to a profile of its own, then reduced to the account session key by a page of
its own, so the token never reaches the script. Copying everything makes the
app reopen the person's own workspace and its real stories: the run stops if a
workspace window opens. The copy is deleted at the end. The app talks to
`https://api.blame.so` because it is a production build.
