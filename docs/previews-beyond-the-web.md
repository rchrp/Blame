# Previews beyond the web

Status: implementation in progress (2026-10-28). Written for an implementing
agent. It covers six steps, in this order:

1. Terminal previews for CLI projects (local and cloud).
2. Cross-platform mobile: web versions in a phone frame, then Expo Go on the
   user's phone (local and cloud).
3. Screen previews for Linux GUI apps, Electron and Tauri (local and cloud).
4. iOS Simulator previews (local, macOS only).
5. Android Emulator previews (local; cloud later).
6. Native macOS and Windows apps through Direct mode (local, no isolation).

Read "Repository rules" (section 12) before writing code.

## 1. Today

A preview is a web page. Everything below exists and must keep working
unchanged for web projects.

- **Contract.** `packages/preview-contract/src/types.ts` defines
  `PreviewManifest`, described as "container-only". A service has `kind`
  (`preview`, `dependency`, `worker`), a container, a command and
  `endpoints` (`http`, `https`, `tcp`). The parser is
  `preview-contract/src/parser.ts`.
- **Run configurations.** `ProjectRunConfiguration` in
  `agent-runtime/src/types.ts` already has `category`: `web`, `mobile`,
  `desktop`, `terminal`, `service`, `other`. A host-only configuration
  (`services: []`) runs on the user's computer through the project runner
  (`app/src/components/backlog/board/use-project-runner.ts`, a host terminal).
  The initialization prompt (`agent-runtime/src/prompt/project-initialization-system.txt`,
  lines 32, 46, 59, 121 to 128) already asks for these host-only
  configurations.
- **Compilation and engine.** `preview-runtime/src/compilation/manifest-compiler.ts`
  turns the manifest into a `PreviewExecutionPlan` (version 2,
  `preview-runtime/src/domain/execution-plan.ts`).
  `preview-runtime/src/compose/compose-renderer.ts` renders it for a
  `local` or `sandbox` target, and `ComposeEngine` runs it on a `DockerHost`.
- **Where it runs.** `RuntimeProfileId` is `local-container` or
  `vercel-compose` (`preview-runtime/src/domain/runtime-profile.ts`).
  - Local: Docker inside the Blame Runtime VM (Lima `vz` on macOS, WSL2 on
    Windows, native on Linux). The desktop drives it through
    `desktop/src/main/preview-runtime/local/` (`LocalPreviewDriver`,
    `vm-docker-host.ts`). Endpoints are published on `127.0.0.1` with
    remembered ports (`local-preview-ports.ts`).
  - Cloud: a Vercel Sandbox (Firecracker microVM) running
    `packages/sandbox-runner`. The runner's gateway
    (`sandbox-runner/src/gateway/`) and `packages/preview-edge` forward HTTP
    and WebSocket, authorized by capability tokens and access tickets.
  - Direct (`WorkspaceMode` `direct`, `desktop/src/main/workspace-mode.ts`):
    the story runs in the project folder; the project runner runs its own
    command.
- **Capabilities.** `RuntimeCapabilities` and `resolveCapabilities`
  (`preview-runtime/src/domain/runtime-capabilities.ts`,
  `compilation/capability-resolver.ts`) report what a profile can run.
- **Display.** The story preview renders a native `WebContentsView`
  (`app/src/components/backlog/drawer/native-preview.tsx`,
  `desktop/src/main/preview-browser/preview-browser-manager.ts`).
- **Agent tools.** The story agent sees the preview through
  `get_preview_devtools` and the `preview_devtools__*` tools (Chrome
  DevTools MCP against a CDP proxy), `project_app` in Direct mode, and
  `get_preview_container_logs` (`agent-runtime/src/preview-harness-tools.ts`).
- **Worktrees on macOS.** A local-container story worktree lives inside the
  VM (`/home/blame/.local/share/blame/runtime/worktrees`). The VM mounts the
  Mac's home folder writable (`desktop/resources/runtime/macos/lima/blame-runtime.yaml`,
  `mounts: [~]`). `desktop/src/main/runtime-workspace-mirror.ts` already
  copies a worktree's sources into `~/Library/Caches/...` for scans.
- **Terminal.** The app has xterm.js (`@xterm/xterm` 6) and a terminal view
  (`app/src/components/backlog/development/development-terminal.tsx`). The
  desktop has node-pty (`desktop/src/main/terminal-ipc.ts`).

## 2. Decisions

D1. **Separate what is shown from where it runs.** A preview has a
*surface* (web, terminal, display, device, host window) and a *placement*
(container, host). Containers stay the default and the only placement in
the cloud.

D2. **Container surfaces compile to ordinary Compose services.** Terminal
and display surfaces become services and endpoints in the existing plan.
No new engine: they work in the local VM and in the sandbox runner with the
same renderer. Every stream uses HTTP or WebSocket so the existing gateway,
edge and port publication carry it. No WebRTC or UDP.

D3. **Device surfaces run on the host and are local only.** The iOS
Simulator and the Android Emulator are not Compose services. A new host-side
service in the desktop manages them. The services an app depends on (API,
Metro) still run in containers.

D4. **The renderer never holds cloud credentials.** The desktop main process
opens upstream connections, and gives the renderer either IPC (terminal) or a
loopback WebSocket with a single-use token (display, device screen). The
pattern already exists in `desktop/src/main/preview-browser/cdp-websocket-server.ts`.

D5. **The agent sees every surface.** Each surface ships agent tools for
reading the state, taking a screenshot and acting (type, tap, click), like
`preview_devtools__*` for the web. Screenshots go through the existing
`recordSessionScreenshots` and `previewToolModelOutput`
(`agent-runtime/src/preview-screenshots.ts`).

D6. **"Not here" is a state, not a failure.** When the story's runtime
cannot run a surface (an iPhone app in a cloud story, an iPhone app on
Windows), the preview shows why and what the user can do, never a red error.

D7. **Reuse open source, pinned.** Third-party binaries and images are pinned
by version and checksum or digest, downloaded on first use or baked into
images, and their licenses listed in section 13.

D8. **Backward compatible.** New manifest fields are optional. A manifest
without them compiles to a byte-identical version 2 plan, so existing cloud
sessions are not recreated and old runners keep working. A plan that uses a
terminal or display surface is version 3 and needs the new runner.

## 3. Contract changes (shared by all steps)

### 3.1 Manifest (`preview-contract/src/types.ts`)

```ts
/** What the user sees for a preview service. Default: { type: "web" }. */
export type PreviewManifestSurface =
  | { type: "web"; device?: "phone" | "tablet" }
  | { type: "terminal"; columns?: number; rows?: number }
  | { type: "display"; width?: number; height?: number };

export type PreviewManifestService = {
  // ...existing fields
  /** Only on kind "preview". */
  surface?: PreviewManifestSurface;
};

/** An app installed on a simulator or emulator on the user's computer. */
export type PreviewManifestDeviceTarget = {
  id: string;
  platform: "ios" | "android";
  /** Folder of the native project, relative to the repository root. */
  projectDir: string;
  toolchain: "xcode" | "expo" | "react-native" | "flutter" | "gradle";
  /** Commands run on the host in projectDir before the build, in order
   *  (for example "pod install", "npx expo prebuild --platform ios"). */
  prepare?: string[];
  build: {
    // xcode, expo and react-native on iOS
    workspace?: string;      // relative to projectDir, e.g. "App.xcworkspace"
    project?: string;        // e.g. "App.xcodeproj"
    scheme?: string;
    configuration?: string;  // default "Debug"
    // gradle, expo and react-native on Android
    module?: string;         // default "app"
    variant?: string;        // default "debug"
    // flutter only: Blame runs `flutter run` itself (section 9.3)
    flavor?: string;
    target?: string;         // e.g. "lib/main.dart"
  };
  app: {
    bundleId?: string;       // iOS
    applicationId?: string;  // Android
    launchActivity?: string; // Android, optional
  };
  device?: {
    model?: string;          // "iPhone 17", "Pixel 9"
    os?: string;             // "26.0", "35" (API level)
  };
  environment?: PreviewManifestEnvironment;  // build and launch environment
  dependsOn?: string[];      // service ids that must be ready first
  bindings?: PreviewManifestDeviceBinding[];
};

export type PreviewManifestDeviceBinding = {
  target: { type: "environment"; key: string };
  source: { service: string; endpoint: string };
  format?: "url" | "host" | "port" | "host-port";
  path?: string;
};

export type PreviewManifest = {
  // ...existing fields
  devices?: PreviewManifestDeviceTarget[];
};
```

Update the type comment on `PreviewManifest`: it is no longer
container-only, and `devices` is the host-side part.

### 3.2 Parser rules (`preview-contract/src/parser.ts`, tests in `parser.test.ts`)

- `surface` is accepted only on `kind: "preview"`. Unknown types are
  rejected.
- `terminal`: `columns` from 40 to 300 (default 120), `rows` from 10 to 100
  (default 32). The service must have a `command`. It must not declare an
  endpoint with id `terminal`: Blame adds it.
- `display`: `width` from 640 to 3840 (default 1280), `height` from 480 to
  2160 (default 800). The service must have a `command`. Endpoint id
  `display` is reserved, and so is the service id `<id>__display`.
- `web` with `device`: the service needs an `http` or `https` endpoint, as
  today.
- `devices[]`: ids unique among themselves and with service ids, matching
  the existing id pattern. `platform` and `toolchain` must match:
  `xcode` is iOS only, `gradle` is Android only, the others are both.
  - iOS `xcode`, `expo`, `react-native`: `app.bundleId` is required, and
    so is `build.scheme` with exactly one of `workspace` or `project`.
    For `expo`, Blame runs `npx expo prebuild` and reads the generated
    workspace, so `scheme` may be omitted.
  - Android `gradle`, `expo`, `react-native`: `app.applicationId` required.
  - `flutter`: `bundleId` (iOS) or `applicationId` (Android) required.
  - `projectDir` and every `build` path are relative, inside the project,
    without `..`.
  - `prepare` commands follow the existing command rules (no Docker, no
    sudo, no interactive prompts).
  - `dependsOn` and `bindings[].source` reference existing services and
    endpoints.
- Environment values in `devices[].environment` go through
  `previewEnvironmentValueRejection`, like services.

### 3.3 Run configurations (`agent-runtime/src/types.ts`)

```ts
export type ProjectRunConfiguration = {
  // ...existing fields
  /** A manifest device target this configuration previews. */
  previewTarget?: string;
};
```

Rules, in `agent-runtime/src/project-preview-validation.ts`:

- At most one of `previewService` and `previewTarget`.
- `previewTarget` needs `category: "mobile"`. `services` lists the services
  the device app needs (it may be empty).
- `previewUrl` stays only for `web` surfaces. A terminal or display
  configuration has `previewService` and no `previewUrl`.
- `app/src/components/backlog/board/project-run-configuration.ts` picks the
  preview configuration by `previewUrl` today. Change it to accept
  `previewService` or `previewTarget` as well, and keep the current order
  for web projects.

### 3.4 Execution plan (`preview-runtime/src/domain/execution-plan.ts`)

```ts
export type ServiceSurfacePlan =
  | { type: "web"; device?: "phone" | "tablet" }
  | { type: "terminal"; columns: number; rows: number; endpointId: "terminal" }
  | { type: "display"; width: number; height: number;
      endpointId: "display"; sidecarServiceId: string };

export type ServiceLaunchPlan = {
  // ...existing fields
  surface?: ServiceSurfacePlan;   // omitted for plain web services
};

export type PreviewExecutionPlan = {
  version: 2 | 3;   // 3 when a terminal or display surface exists
  // ...existing fields
  tools?: { ttyd?: true };   // tools the plan needs mounted (section 4.2)
};
```

Device targets are not part of the execution plan. They are compiled by
the desktop (section 8.2) from the manifest.

`EndpointMap` routes (`domain/endpoint-map.ts`) get
`surface?: "web" | "terminal" | "display"`, so the UI and the edge know what
a route carries.

### 3.5 Capabilities

Add to `RuntimeCapabilities`:

```ts
terminalSurface: boolean;   // local-container: true, vercel-compose: true after the runner release
displaySurface: boolean;    // local-container: true, vercel-compose: true after the runner release
```

Device targets are checked by the desktop's device service (section 8.3),
not by `resolveCapabilities`: they depend on the user's computer (macOS,
Xcode, Android SDK), not on the runtime profile. For a `vercel-compose`
story, the device service reports `unavailable` with reason
`cloud_story`.

Add the incompatibility code `SURFACE_UNSUPPORTED` with a readable message,
for example "Terminal previews need sandbox runner 0.3.0 or later."

## 4. Shared infrastructure

### 4.1 One preview surface switch in the app

Create `app/src/components/backlog/drawer/preview-surface.tsx`. It receives
the selected run configuration, the manifest and the lifecycle, and renders:

| Surface | Component | Step |
| --- | --- | --- |
| web | existing `NativePreviewPanel` | today |
| web + device | `NativePreviewPanel` inside `PhoneFrame` | 2 |
| terminal | `TerminalSurfaceView` | 1 |
| display | `DisplaySurfaceView` | 3 |
| device target | `DeviceSurfaceView` | 4, 5 |
| host-only desktop configuration | `HostWindowPanel` | 6 |

`user-story-preview.tsx` is over its line budget (2035, going to 1950):
replace its direct use of `NativePreviewPanel` with `PreviewSurface` in one
place and move code out, never in. Each surface view lives in its own file
under `app/src/components/backlog/drawer/surfaces/`.

All views share:

- the same lifecycle header and `PreviewFailurePanel` as web previews;
- a small toolbar (neutral icons, existing `Button` variants, no colored
  icons, no gradients, as in the rest of the app);
- an "Unavailable here" state (D6) with a title, one sentence and one
  action.

### 4.2 Blame tools mounted into preview containers

Terminal previews need `ttyd` inside the project's container, whatever its
image.

- Use the official static `ttyd` binaries (`ttyd.x86_64`, `ttyd.aarch64`),
  version pinned with SHA-256 in a new `preview-runtime/src/compose/blame-tools.ts`.
- Local: the Blame Runtime image installs them at `/opt/blame/tools/`
  (runtime image build scripts, new runtime release). Until the new runtime
  ships, the desktop copies them into the VM on first use through the
  runtime agent and checks the hash.
- Cloud: the sandbox runner image includes them at the same path.
- `renderCompose` adds a read-only bind mount
  `/opt/blame/tools:/opt/blame/tools:ro` to every service whose plan has
  `surface.type === "terminal"`, for both targets.

### 4.3 Surface proxy in the desktop

Create `desktop/src/main/preview-surfaces/surface-proxy.ts`:

- `openSurfaceChannel({ storyId, serviceId, endpointId })` returns
  `{ url: "ws://127.0.0.1:<port>/<token>" }`.
- The token is single-use. The listener accepts one connection and closes
  with it or after 30 s without a connection.
- Upstream for a local story: `ws://127.0.0.1:<published host port>/<path>`.
- Upstream for a cloud story: the route's public URL on the preview edge,
  authenticated the way `desktop/src/main/preview-runtime/cloud-preview-client.ts`
  authenticates the preview browser (access ticket from
  `/preview-sessions/:id/access-ticket`). Read `preview-edge/src/preview-session-auth.ts`
  to reuse the exact exchange.
- For device screens (section 8.4), the upstream is a local frame source
  instead of a socket. Same API.

### 4.4 Agent tools

Create `agent-runtime/src/preview-surface-tools.ts`. Do not grow
`cline-runtime.ts` (at its 4900-line budget). Register the tools next to
`previewDevtoolsTool` through `PreviewToolRuntimeOptions`, with callbacks
the desktop implements, like `previewDevtools`.

A tool is offered only when the story's selected run configuration uses
that surface:

- `preview_terminal` (step 1)
- `preview_display` (step 3)
- `preview_device` (steps 4 and 5)

Each returns `{ status, message, ... }` with the same readiness vocabulary
as `get_preview_devtools` (`ready`, `starting`, `stopped`, `failed`,
`unavailable`), so prompts stay simple. Update
`agent-runtime/src/cline-runtime-prompts.ts` to describe the tool of the
story's surface in one paragraph, and only that one.

### 4.5 Preview Environment page

The page (`app/src/pages/initialization/`) shows the new parts:

- `environment-kinds.tsx`: add kinds `terminal` (icon `SquareTerminal`),
  `display` (`Monitor`), `ios` and `android` (`Smartphone`), and host window
  (`AppWindow`). Same neutral icon style as the others.
- `environment-setup-view.tsx`: a section "Devices" after services, one
  card per device target: platform, toolchain, scheme or module,
  bundle id or application id, device model, "Waits for …".
- `environment-start-order.ts`: device targets come after every service
  they depend on.
- The editor (`initialization-setup.tsx`) edits a device target's
  `prepare` commands, `build` fields, `app` ids and `device`, with the same
  validation as the parser.

## 5. Step 1: terminal previews for CLI projects

Goal: a C, C++, Rust, Go, Python, Node or other CLI runs in its container,
and the user and the agent use it in a terminal inside the story preview.
Local and cloud.

### 5.1 Compilation

In `manifest-compiler.ts`, a service with `surface.type === "terminal"`
becomes:

- `command`:
  ```
  /opt/blame/tools/ttyd --port 7681 --interface 0.0.0.0 --writable
    --max-clients 1 --ping-interval 20 --
    sh -c '<original command>; code=$?;
           printf "\033]1337;BlameExit=%s\007" "$code"; exit "$code"'
  ```
  Quote the original command with the existing command normalization
  helpers (`compilation/command-normalization.ts`), never by string
  concatenation without escaping. The OSC sequence is invisible in xterm and
  gives a reliable exit code.
- an added endpoint `{ id: "terminal", protocol: "http", port: 7681,
  healthcheck: { type: "tcp", timeoutMs: 30000 } }`;
- `surface: { type: "terminal", columns, rows, endpointId: "terminal" }`;
- `tools.ttyd = true` and `version: 3`.

The environment gets `TERM=xterm-256color`, `COLORTERM=truecolor` and
`LANG=C.UTF-8` unless the manifest sets them.

ttyd starts one process per WebSocket connection. Only the desktop main
process connects (`--max-clients 1`), and it shares that one session with
the user's view and the agent (section 5.2). A reconnect starts a new
process: the view shows "The program restarted after the connection was
lost."

### 5.2 Desktop terminal session

Create `desktop/src/main/preview-surfaces/terminal-surface.ts`:

- Connects to the ttyd endpoint (local published port, or the edge through
  the surface proxy's upstream logic) with the ttyd WebSocket protocol.
  Verify the message format against the pinned ttyd source before writing
  the client (`html/src/components/terminal/xterm/index.ts` in the ttyd
  repository): subprotocol `tty`, a first JSON message with the size, then
  one-character prefixes for input, resize and output.
- Keeps an `@xterm/headless` terminal of the same size, fed with every
  output byte, for the agent and for replay.
- Detects the `BlameExit` sequence and records the exit code.
- Exposes over IPC a client with the shape of the existing
  `TerminalClient` (`app/src/context/platform.ts`): `attach(scope)` returns
  the replay (serialized headless buffer) and an id; then `write`, `resize`,
  `onEvent`, plus `restart(scope)`. Add it to `Platform` as
  `previewTerminal`.
- One session per story and service. Closing the story preview keeps it;
  stopping the preview closes it.

### 5.3 App view

`surfaces/terminal-surface-view.tsx` reuses the xterm setup of
`development-terminal.tsx` (extract the shared part into a hook, do not copy
it). Toolbar: Restart, Copy all. Status line: "Running" or "Exited with code
N · Run again". The terminal fits the panel and sends resizes.

### 5.4 Agent tool `preview_terminal`

Input `{ action, text?, key?, pattern?, timeoutMs? }`:

- `read`: visible screen as text (trailing spaces trimmed), cursor
  position, `exited` and `exitCode`. At most 200 lines of scrollback,
  bounded like `previewDevtoolsBoundedArguments`.
- `type`: writes `text`. `submit: true` adds Enter (`\r`).
- `key`: one of `Enter`, `Tab`, `Escape`, `Backspace`, `Up`, `Down`,
  `Left`, `Right`, `Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+L`.
- `wait_for`: waits until `pattern` (a regular expression, at most 200
  characters) appears on the screen or the program exits, up to `timeoutMs`
  (default 10 s, max 60 s).
- `restart`: restarts the program.

The description says the user sees the same terminal, so the agent should
not clear it without reason.

### 5.5 Cloud

- Sandbox runner: ship ttyd in the image (section 4.2), accept plan
  version 3, render the bind mount, keep WebSocket connections open (check
  the idle timeouts of `sandbox-runner/src/gateway/websocket-forwarder.ts`
  and `preview-edge/src/websocket-forwarder.ts`; ttyd pings every 20 s).
- Set `terminalSurface: true` for `vercel-compose` only when the session's
  runner version supports it. Release the runner (`pnpm release:sandbox-runner`)
  and bump the API's pinned runner version, as described in `RELEASING.md`.

### 5.6 Initialization

Prompt (`project-initialization-system.txt`):

- Replace the rule at line 46 for CLIs: a CLI or TUI gets a terminal
  surface instead of no preview. Pick the command a user runs first: a
  REPL or TUI as is; for a one-shot CLI, its `--help` or a short demo from
  the README.
- Add one example: a Python Click CLI (`python:3.13-slim`, setup task
  `pip install -e .`, service `cli` with `surface: {"type":"terminal"}` and
  command `mytool --help`, run configuration `category: "terminal"`,
  `previewService: "cli"`).
- Libraries with no CLI keep no preview.

Validation adds: a terminal service with an `http` endpoint other than
`terminal` gets a warning ("A terminal preview does not need its own HTTP
endpoint").

### 5.7 Done when

- Parser, compiler and renderer tests cover terminal services, version 3,
  the bind mount and unchanged version 2 output for the parity corpus
  (`desktop/src/main/preview-parity.test.ts` and its golden files).
- A `terminal-surface.test.ts` covers the protocol, exit detection and
  replay against a fake ttyd server.
- Manually, locally and in the cloud: a Python Click CLI, a Rust CLI
  (`rust:1-slim`, `cargo build`), a C CLI with `make`, and a TUI
  (for example a Textual app). Type, resize, exit, restart; the agent uses
  `preview_terminal` to run a command and reads the result.

## 6. Step 2: cross-platform mobile

Goal: Expo, Flutter, Ionic and Capacitor projects show their app at phone
size right away, in local and cloud stories; Expo projects also open on the
user's own phone.

### 6.1 Web versions in a phone frame

- Manifest: `surface: { type: "web", device: "phone" }` on the web service.
- App: `PhoneFrame` (in `surfaces/phone-frame.tsx`) sizes the
  `NativePreviewPanel` area to 390 × 844 CSS pixels (tablet: 820 × 1180),
  scaled down to fit, with a plain rounded frame. Label in the toolbar:
  "Web version". A tooltip says the native app may differ.
- Desktop: when the preview has a device hint, `preview-browser-manager.ts`
  calls `webContents.enableDeviceEmulation` (mobile screen, device scale
  factor 3, view size of the frame), and sets a mobile user agent and touch
  emulation (CDP `Emulation.setTouchEmulationEnabled`). The agent's devtools
  page gets the same emulation, so its screenshots match.
- Initialization prompt, with one example each:
  - Expo with web support (`react-native-web` in dependencies):
    `npx expo start --web --port 8081`, endpoint 8081.
  - Flutter: `flutter run -d web-server --web-hostname 0.0.0.0 --web-port 8080`
    in a pinned Flutter image (pick a maintained one, pin its digest);
    caches for the pub cache.
  - Ionic and Capacitor: the web framework's dev server.
  - React Native without `react-native-web`: no web version; the target
    comes from steps 4 and 5.

### 6.2 Expo Go on the user's phone

Only for Expo projects that Expo Go can run: no `expo-dev-client`, no
committed `ios/` or `android/` folder with custom native code.

- Manifest: a `metro` service (`kind: "preview"`, `surface: web`, port 8081)
  running `npx expo start --port 8081 --host lan`. When the project has web
  support, the same service serves the web version.
- App: a "Open on your phone" button opens a dialog with a QR code of the
  `exp://` link and one sentence: "Scan with the Expo Go app. It must
  support this project's Expo SDK."

How the phone reaches Metro differs by placement and must be settled by
**spike S2** before building the dialog:

- **Cloud story.** The phone opens the preview edge. Add a "device link"
  to the edge: an extra hostname for the `metro` route, valid for 2 hours,
  accepted without a cookie, revoked when the dialog closes or the preview
  stops (`preview-edge/src/preview-route-resolver.ts`, API route
  resolution). Metro must build its URLs from that hostname:
  `EXPO_PACKAGER_PROXY_URL` exists for this, but a forum report shows the
  Android Expo Go app ignoring the `exps` scheme with it.
- **Local story.** The phone cannot reach `127.0.0.1`. The desktop opens a
  listener on the Mac's LAN address (random port, only while the dialog is
  open, closed after 30 minutes without requests) that forwards to Metro's
  published port. Metro must produce URLs with that LAN address and port:
  either from the request's `Host` header (check Expo CLI's manifest
  middleware) or by restarting Metro with `EXPO_PACKAGER_PROXY_URL`.
  The dialog says: "Anyone on this network can load the app while this
  window is open."

Spike S2 (half a day): with a blank `create-expo-app` project in a
container, find a configuration that loads in Expo Go on iOS and Android
through (a) a reverse proxy with another hostname and HTTPS, and (b) a LAN
proxy on another port. Record what works in this document. If neither works
without rewriting manifests, ship 6.1 only and leave 6.2 for later.

### 6.3 Done when

- Phone frame and device emulation work for an Expo, a Flutter and an Ionic
  project, locally and in the cloud; the agent's screenshots are at phone
  size.
- After spike S2: Expo Go opens a local and a cloud preview of a blank Expo
  app; the link expires and is revoked as specified; tests cover the device
  link expiry and revocation in `preview-edge`.

## 7. Step 3: screen previews for Linux GUI apps, Electron and Tauri

Goal: GTK, Qt, Electron and Tauri apps run in Linux containers with a
virtual screen, shown and used inside the story preview. Local and cloud.

### 7.1 Blame images

Publish, multi-arch (amd64, arm64), pinned by digest in
`preview-runtime/src/compose/blame-images.ts`, signed like the runner
image (Sigstore), on a public registry both the VM's Docker and Vercel
Sandboxes can pull without credentials (GHCR under the project's GitHub
organization):

- `blame-preview-display`: TigerVNC `Xvnc`, `websockify`, Openbox, `xdotool`,
  `wmctrl`, ImageMagick (`import`), common fonts (DejaVu, Noto, Noto Color
  Emoji), and a `blame-display` helper script with subcommands:
  `serve`, `shot`, `click`, `type`, `key`, `scroll`, `drag`, `windows`.
- `blame-gui-node`: Node LTS with Electron's and Chromium's Linux runtime
  libraries (NSS, GTK 3, libgbm, ALSA, libxss, libxshmfence, dbus).
- `blame-gui-tauri`: Rust stable, Node LTS, WebKitGTK 4.1 and the Tauri
  Linux build dependencies.

Sources live in a new `packages/preview-images/` folder (Dockerfiles, the
helper script, a build workflow `.github/workflows/release-preview-images.yml`,
and the license notices of the GPL components). Document the release in
`RELEASING.md`. The runtime upgrade prefetches `blame-preview-display`.

### 7.2 Compilation

A service with `surface.type === "display"` compiles to two services:

- `<id>__display` (sidecar): image `blame-preview-display`, command
  `blame-display serve --display :99 --geometry <w>x<h> --port 6080`.
  `Xvnc` listens on `127.0.0.1:5900` inside the sidecar, with no password
  and `-ac`; `websockify` exposes `0.0.0.0:6080`. Endpoint `display`
  (`http`, 6080, TCP healthcheck). Volume `x11` mounted at
  `/tmp/.X11-unix`.
- `<id>` (the app): the manifest's image and command, plus
  `DISPLAY=:99`, the `x11` volume at `/tmp/.X11-unix`, `shm_size: 1g`
  (rendered by `renderCompose`), and `dependsOn` the sidecar (healthy).

Both get `surface` in the plan, version 3. The VNC server has no password
because it is reachable only through the gateway's capability check (cloud)
or `127.0.0.1` (local), like web previews.

### 7.3 Readiness

The preview is ready when the sidecar is healthy and a visible top-level
window exists (`blame-display windows` returns one), checked every second
for up to 90 s. Until then the lifecycle `step` is "Waiting for the app
window". Timeout: failure "The app started but opened no window", with the
app's last logs.

### 7.4 App view

`surfaces/display-surface-view.tsx` uses noVNC (`@novnc/novnc`, pinned) on
a channel from the surface proxy:

- `scaleViewport: true`, `resizeSession: false` (the size comes from the
  manifest; the Resolution menu changes it by restarting the sidecar with a
  new geometry: 1280 × 800, 1440 × 900, 1920 × 1080).
- Keyboard focus follows clicks on the canvas; paste sends the clipboard
  text through noVNC's clipboard API.
- Toolbar: Restart app, Resolution, Paste, Screenshot.

### 7.5 Agent tool `preview_display`

Input `{ action, x?, y?, toX?, toY?, button?, text?, keys?, deltaY? }`,
implemented with `exec` in the sidecar (`ComposeEngine` exec locally, the
runner's exec in the cloud):

- `screenshot` (`blame-display shot`, PNG), `windows` (titles and frames),
  `click` (`button`: left, right, middle; `double: true`), `type`,
  `key` (xdotool syntax, for example `ctrl+s`), `scroll`, `drag`.

### 7.6 Initialization

Prompt, with one example each:

- Electron (electron-vite or Electron Forge): image `blame-gui-node`, setup
  `pnpm install`, service `app` with `surface: {"type":"display"}` and the
  dev command with `-- --no-sandbox --disable-gpu` (Electron's sandbox
  needs privileges the container does not have). If the renderer is a Vite
  app that works in a browser, also add a web configuration for it.
- Tauri: image `blame-gui-tauri`, caches for `~/.cargo/registry` and
  `src-tauri/target`, command `pnpm tauri dev`.
- GTK and Qt apps: build in a setup task, run in the service. The image
  must contain the GUI libraries: use the project's Dockerfile if it has
  one, or `blame-gui-node`, or a distro image with the packages installed in
  a `build` Dockerfile under the project.

Validation warns when a display service uses a plain language image
(`node:*`, `python:*`, `rust:*`) without `build`: "This image has no
graphical libraries; the app may fail to open a window."

A follow-up outside this spec: for Electron, expose the renderer's DevTools
protocol (`--remote-debugging-port`) to the agent only, so it can use the
`preview_devtools__*` tools on the app's pages.

### 7.7 Done when

- Compiler and renderer tests: sidecar, volume, `shm_size`, reserved ids,
  version 3; parity corpus unchanged.
- Manually, local and cloud: an electron-vite template app, a Tauri
  template app, a GTK 4 hello world, a Qt Widgets example. Click, type,
  paste, resize, restart; the agent clicks a button and checks the
  screenshot.
- Cloud: `displaySurface` is true only with the new runner; the VNC
  WebSocket stays open for 30 minutes of use.

## 8. Device service (shared by steps 4 and 5)

Steps 4 and 5 use one device service. Build it with step 4; step 5 adds
the Android driver. Step 3 does not depend on it.

### 8.1 Placement and source on macOS

A device app builds on the host, but a local-container worktree lives in the
VM. Use a **build mirror**, like the scan mirror in
`runtime-workspace-mirror.ts`:

- Path: `~/Library/Application Support/Blame/device-builds/<projectId>/<storyId>/`.
- Before each build, the VM copies the worktree into it
  (`rsync -a --delete`, run through the runtime agent; the home folder is
  mounted in the VM). It excludes `.git`, and keeps the host-only folders
  that the build creates: `node_modules`, `Pods`, `build`, `.dart_tool`,
  `.gradle`, `DerivedData`, `.expo`, `ios/build`, `android/build`. Copying
  keeps modification times, so incremental builds keep working.
- Host-only dependencies install in the mirror (for example `npm ci` or
  `pnpm install --frozen-lockfile` for React Native and Expo, since VM
  `node_modules` hold Linux binaries; `pod install`).
- The mirror is one-way: nothing written there goes back to the worktree.
  The agent edits the worktree, as today.
- Direct mode: no mirror, the project folder is used as is.
- Cloud stories: no device targets in this spec (D6, reason
  `cloud_story`).
- Linux and Windows: the worktree is readable from the host (native on
  Linux, `\\wsl.localhost\...` on Windows). Android uses a mirror under the
  app data folder on Windows for build speed; Linux uses the worktree
  directly.

### 8.2 Device service in the desktop

Create `desktop/src/main/preview-devices/` with:

```ts
export type DevicePrerequisite = {
  id: string;                 // "xcode-installed", "xcode-selected", ...
  title: string;              // "Xcode installed"
  status: "done" | "missing" | "checking" | "blocked";
  detail?: string;            // one sentence, what to do
  action?:
    | { type: "open-terminal"; command: string }   // the user runs it (sudo)
    | { type: "open-url"; url: string }
    | { type: "install"; label: string };          // Blame downloads it
};

export type DeviceAvailability =
  | { status: "ready" }
  | { status: "missing-prerequisites"; prerequisites: DevicePrerequisite[] }
  | { status: "unavailable";
      reason: "not_macos" | "cloud_story" | "unsupported_arch" };

export interface DeviceDriver {
  readonly platform: "ios" | "android";
  availability(): Promise<DeviceAvailability>;
  ensureDevice(story: DeviceStory, target: PreviewManifestDeviceTarget):
    Promise<DeviceHandle>;                   // create if needed, boot
  build(story: DeviceStory, target: PreviewManifestDeviceTarget,
        progress: (step: string) => void, signal: AbortSignal):
    Promise<DeviceBuildResult>;              // artifact path or readable failure
  install(handle: DeviceHandle, artifact: string): Promise<void>;
  launch(handle: DeviceHandle, target: PreviewManifestDeviceTarget,
         environment: Record<string, string>): Promise<void>;
  terminate(handle: DeviceHandle, target: PreviewManifestDeviceTarget): Promise<void>;
  shutdown(handle: DeviceHandle): Promise<void>;
  destroy(handle: DeviceHandle): Promise<void>;
  screen(handle: DeviceHandle): DeviceScreenSource;
  input(handle: DeviceHandle): DeviceInput;
  describeUi(handle: DeviceHandle): Promise<DeviceUiNode[]>;
  logs(handle: DeviceHandle, target: PreviewManifestDeviceTarget,
       signal: AbortSignal): AsyncIterable<string>;
}

export type DeviceBuildResult =
  | { ok: true; artifact: string; durationMs: number }
  | { ok: false; summary: string; errors: Array<{ file?: string;
      line?: number; message: string }>; logTail: string };
```

`DeviceTargetService` (one instance) runs a story's target:

1. Start the services in `dependsOn` through the existing preview path and
   wait until they are ready.
2. Resolve `bindings` to the services' published host ports (section 8.5).
3. `prepare` commands, then `build`, then `ensureDevice`, `install`,
   `launch`. Build and boot run in parallel.
4. Project the progress into `PreviewLifecycleState` with `step` texts:
   "Booting the iPhone simulator", "Building the app", "Installing",
   "Launching". A build failure is `phase: "failed"` with the build summary
   as message and the errors in the failure panel.
5. Rebuild on demand (toolbar "Rebuild", agent `preview_device` action
   `build_and_run`). No automatic rebuild on file change in this spec.

Locks: one build per story at a time; at most two booted Blame devices per
platform (setting, default 2): starting a third shuts down the least
recently used one. Devices idle for 20 minutes shut down, using the rule of
`local-preview-idle.ts`. Deleting or archiving a story destroys its device
and its mirror. At startup, devices whose name starts with "Blame · " and
whose story no longer exists are destroyed.

State is stored per story in the desktop's data folder
(`device-targets.json`: device id, last artifact, last build time), never in
the worktree.

### 8.3 Availability in the UI

`DeviceSurfaceView` shows, before anything starts:

- `unavailable` `not_macos`: "iPhone previews need a Mac with Xcode."
- `unavailable` `cloud_story`: "Device previews run on your computer. This
  story runs in the cloud."
- `missing-prerequisites`: a checklist like the iOS one below, each step
  with its action. Checks run again automatically every 3 s while the
  checklist is visible, and once when the window regains focus.

### 8.4 Screen streaming and input

- The driver's `DeviceScreenSource` gives JPEG frames and the screen size
  in pixels and points.
- The surface proxy (section 4.3) serves them to the renderer:
  - server to client: binary messages are JPEG frames; text messages are
    JSON `{type:"meta", width, height, pointWidth, pointHeight}` and
    `{type:"state", ...}`;
  - client to server, JSON: `{type:"touch", phase:"down"|"move"|"up",
    x, y}` with x and y from 0 to 1; `{type:"text", text}`;
    `{type:"key", key}`; `{type:"button", button}` (`home`, `lock`,
    `back`, `app-switch`, `volume-up`, `volume-down`).
- Send a frame only when it changed (compare a hash). Target 15 fps,
  JPEG quality 70. Drop frames when the socket is backed up.
- `DeviceSurfaceView` draws frames on a `<canvas>` in a plain device frame,
  scaled to fit, and turns pointer, wheel and keyboard events into the
  messages above. Toolbar: Home, Restart app, Rebuild, Screenshot,
  Appearance (light or dark), Open URL, Logs.

### 8.5 Reaching services from the app

- iOS Simulator shares the Mac's network: a binding resolves to
  `http://127.0.0.1:<published host port>`.
- Android Emulator: Blame runs `adb reverse tcp:<logical port>
  tcp:<host port>` for every endpoint the target depends on, so the app
  reaches `http://localhost:<logical port>` as in web development. Bindings
  resolve to that URL.
- Binding values go into the `prepare` and build environment, and into the
  launch environment (`SIMCTL_CHILD_<KEY>` on iOS, which `simctl launch`
  passes to the app). How the app reads them stays the project's own
  configuration; the initialization agent wires it only when the project
  already reads such a variable.
- Expo and React Native: Metro runs in a container (section 6.2) and is a
  `dependsOn` service. iOS reaches it at `127.0.0.1:<host port>`; set
  `RCT_METRO_PORT` for the build. Android reaches it through `adb reverse
  tcp:8081 tcp:<host port>`.

### 8.6 Agent tool `preview_device`

Input `{ action, x?, y?, toX?, toY?, text?, key?, button?, url? }`:

- `status`: availability, lifecycle, device model and OS, app state.
- `screenshot`: PNG through the screenshot pipeline (D5).
- `describe_ui`: the accessibility tree, compacted to role, label, value
  and frame in points, at most 400 nodes.
- `tap`, `swipe` (from x,y to toX,toY), `type`, `key`, `button`: in points,
  as `describe_ui` reports them.
- `open_url`: deep link.
- `build_and_run`: rebuilds and relaunches; returns the build result's
  summary and errors on failure.
- `logs`: the app's last 200 log lines.

The prompt paragraph tells the agent to call `describe_ui` before tapping,
and that a build failure's errors point at worktree files, not the mirror
(map mirror paths back to worktree paths in the result).

## 9. Step 4: iOS Simulator (local, macOS)

Goal: a native iOS app (SwiftUI or UIKit), an Expo or React Native app
built for iOS, or a Flutter app runs in a simulator per story, shown in the
story preview and usable by the agent.

### 9.1 Tools

- Apple's `xcrun simctl`, `xcodebuild`, `xcresulttool` (Xcode).
- **AXe** (MIT) for screen frames (`axe stream-video --format mjpeg`),
  touches, typing, hardware buttons, `describe-ui` and screenshots. Blame
  downloads a pinned release into its data folder and checks its SHA-256;
  a Homebrew install is used if present and of a supported version.
- AXe depends on Apple's private SimulatorKit, which moved in an Xcode 27
  beta and broke it (XcodeBuildMCP issue 446). So: check `axe --version`
  and a test frame at startup; when AXe fails, fall back to
  `simctl io <udid> screenshot` polling (2 fps) and `simctl`-only actions,
  and show "Limited preview: touches are unavailable with this Xcode
  version." Never crash.
- Not used: WebDriverAgent (and so mobile-mcp for iOS) is heavier than AXe
  for the same actions. XcodeBuildMCP (MIT) is optional: in Direct mode the
  agent already runs on the Mac and may get it as an MCP server later.

### 9.2 Prerequisites checklist

In this order, mirroring the Xcode setup flow users know:

1. **Xcode installed**: `/Applications/Xcode*.app` exists and
   `xcodebuild -version` works. Action: open the App Store page of Xcode.
2. **Xcode selected**: `xcode-select -p` points inside an Xcode app, not
   Command Line Tools. Action `open-terminal`:
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
   (the user types their password; Blame never asks for it).
3. **License and first launch**: `xcodebuild -checkFirstLaunchStatus`.
   Action `open-terminal`: `sudo xcodebuild -runFirstLaunch`.
4. **iOS simulator runtime**: `xcrun simctl list runtimes --json` has an
   available iOS runtime. Action `install` runs
   `xcodebuild -downloadPlatform iOS` with progress, after a confirmation
   that names the size (several GB).
5. **Simulator controls (AXe)**: action `install` downloads it.

### 9.3 Driver `ios-driver.ts`

- Device per story: `simctl create "Blame · <story title, 30 chars> · <short id>"
  <device type> <runtime>`. The device type is the manifest's `model` when
  available, else the newest iPhone (non-Pro, non-Max) of the newest
  runtime.
- Boot headless (`simctl boot`, then `simctl bootstatus <udid> -b`). Never
  open Simulator.app.
- Build:
  - `xcode`, `react-native`, and `expo` after `npx expo prebuild --platform ios`:
    `xcodebuild -workspace|-project … -scheme … -configuration Debug
    -destination id=<udid> -derivedDataPath <mirror>/.blame/DerivedData
    -resultBundlePath <tmp>.xcresult CODE_SIGNING_ALLOWED=NO build`.
    The artifact is the `.app` under DerivedData's
    `Build/Products/Debug-iphonesimulator/`.
    Failures: read issues with `xcrun xcresulttool get build-results`
    (check the flag spelling for the installed Xcode) into
    `DeviceBuildResult.errors`; map mirror paths to worktree paths.
  - `flutter`: run `flutter run -d <udid> --machine` in a host process kept
    for the session. Parse its JSON events for progress and errors.
    "Rebuild" sends a hot restart (`app.restart` over the daemon protocol)
    instead of rebuilding. Requires Flutter on the host: add "Flutter
    installed" to the checklist when the target uses it.
- `install`: `simctl install`. `launch`: `simctl launch
  --terminate-running-process <udid> <bundleId>` with `SIMCTL_CHILD_*`
  variables.
- Logs: `simctl spawn <udid> log stream --style compact --predicate
  'process == "<executable>"'`.
- Buttons: Home and Lock through AXe; Appearance through
  `simctl ui <udid> appearance light|dark`; Open URL through
  `simctl openurl`.
- Pixels to points: from AXe's `describe-ui` root frame and the frame size.

### 9.4 Initialization

- Scan evidence: `*.xcodeproj`, `*.xcworkspace`, `Podfile`, `Info.plist`,
  `project.yml` (XcodeGen), `Project.swift` (Tuist), `app.json` or
  `app.config.*` with Expo, `pubspec.yaml` with `flutter`. Check that
  `agent-runtime/src/project-discovery.ts` collects them; add what is
  missing without growing past its budget (1006, going to 1000).
- Prompt: produce a `devices[]` iOS target and a `mobile` run configuration
  with `previewTarget`. Read the scheme from the project
  (`xcodebuild -list` is not available to the agent: read
  `xcshareddata/xcschemes/*.xcscheme` and `project.pbxproj`), and the
  bundle id from the target's build settings. XcodeGen and Tuist projects
  get a `prepare` command (`xcodegen generate`, `tuist generate`).
  CocoaPods projects get `pod install`.
- Change the blocked category `unsupported_stack`
  (`agent-runtime/src/initialization-session.ts`) to: "The project cannot
  be previewed by any surface Blame supports (for example watchOS, tvOS or
  visionOS apps, firmware, apps that need physical hardware)." Update the
  example in `initialization-session.test.ts` ("This is an iOS app with no
  server").

### 9.5 Done when

- Unit tests for the driver's command building and parsing (fake
  `simctl`, `xcodebuild`, `axe` outputs), the device lifecycle (create,
  limit of two, idle shutdown, orphan cleanup) and path mapping.
- Manually on a Mac: a new SwiftUI app from Xcode's template, an Expo app
  with `expo prebuild`, a Flutter app. Prerequisites shown and resolved
  from a machine with only Command Line Tools selected; build failure shows
  the Swift error with the worktree path; tap, type, Home, appearance,
  rebuild; the agent changes a label, rebuilds and checks it with
  `describe_ui` and a screenshot. Two stories run two simulators at once.

## 10. Step 5: Android Emulator (local; cloud later)

Goal: a native Android app (Gradle), an Expo or React Native app built for
Android, or a Flutter app runs in an emulator per story. macOS, Windows and
Linux.

### 10.1 Where the build runs

Google publishes no Linux arm64 `aapt2`, so Gradle builds cannot run in the
arm64 Blame Runtime VM of Apple Silicon Macs. And the emulator needs the
Android SDK on the host anyway. So in this spec **Android builds run on the
host**, from the build mirror (section 8.1), with the host SDK.

Later option, not in this spec: Lima's Rosetta for Linux (`vz` with
`rosetta: enabled`) to run an amd64 build container on Apple Silicon, and
plain containers on x86_64 hosts.

### 10.2 Prerequisites

1. **Android SDK**: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the default
   folder (`~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`,
   `~/Android/Sdk`). Action `install`: download Google's command-line tools
   into Blame's data folder.
2. **Licenses**: `sdkmanager --licenses` must be accepted by the user.
   Action `open-terminal` with that command; Blame never accepts them
   itself.
3. **Emulator, platform tools and a system image**: `sdkmanager
   "emulator" "platform-tools" "system-images;android-<api>;google_apis;<abi>"`
   with `abi` `arm64-v8a` on Apple Silicon and Linux arm64, else `x86_64`.
   Action `install` after a confirmation that names the size.
4. **Hardware acceleration**: `emulator -accel-check`. On Linux, `/dev/kvm`
   must be accessible (detail: add the user to the `kvm` group).
5. **Java**: a JDK matching the project's Android Gradle Plugin (17 or 21).
   Use the one bundled with Android Studio if present, else action
   `open-url` to Adoptium.

### 10.3 Driver `android-driver.ts`

- One base AVD, `Blame_Phone` (Pixel profile, the installed system image),
  created with `avdmanager` on first use.
- One emulator process per story: `emulator -avd Blame_Phone -read-only
  -no-snapshot-save -no-window -no-audio -no-boot-anim -port <even port>
  -grpc <port>`, then `adb -s emulator-<port> wait-for-device` and poll
  `getprop sys.boot_completed`. `-read-only` lets several instances share
  the AVD; each story gets a clean device on every start.
- Screen and input through the emulator's gRPC service
  (`emulator_controller.proto`: screenshot streaming, touch, key and mouse
  events). Generate the client from the proto of the pinned emulator
  version. Recent emulators require a gRPC token; read it as the emulator
  documents (discovery file of the running instance). Fallback when gRPC is
  not available: `adb exec-out screencap -p` polling (2 fps) and
  `adb shell input`.
- Build: `./gradlew :<module>:assemble<Variant>` in the mirror with
  `JAVA_HOME` set and a Gradle home under Blame's data folder (shared cache
  across stories); `expo`: `npx expo prebuild --platform android` first;
  `react-native`: Gradle in `android/`; `flutter`: `flutter run -d
  emulator-<port> --machine` as in section 9.3. Errors: parse
  `e: file:///…:<line>:<col> <message>` (Kotlin) and `<file>:<line>: error:`
  (Java) lines; map mirror paths to worktree paths.
- `install`: `adb install -r`. `launch`: `adb shell monkey -p
  <applicationId> -c android.intent.category.LAUNCHER 1`, or `am start -n`
  with `launchActivity`.
- `describeUi`: `adb exec-out uiautomator dump /dev/tty`, parsed into
  `DeviceUiNode[]` (bounds converted to dp with the display density).
- Logs: `adb logcat --pid=$(adb shell pidof -s <applicationId>)`.
- Buttons: Back, Home, App switch, volume through key events.

### 10.4 Cloud (later)

Android in the cloud needs `/dev/kvm`. Firecracker does not expose
hardware virtualization to its microVMs, so Vercel Sandboxes very likely
cannot run the emulator at a usable speed. Spike S5 (one hour): in a
Vercel Sandbox, check `ls -l /dev/kvm` and `grep -c vmx\|svm /proc/cpuinfo`;
record the answer here. If absent, a cloud Android profile needs another
provider with KVM (bare metal, or VMs with nested virtualization), for
example with Google's `android-emulator-container-scripts`. Out of scope
here; the device service reports `cloud_story` for cloud stories.

### 10.5 Done when

- Unit tests for SDK detection on the three platforms, command building,
  Gradle error parsing, uiautomator parsing, the gRPC client against a
  recorded fake.
- Manually on macOS (Apple Silicon) and Windows: Android Studio's "Empty
  Activity" Compose template, an Expo app, a Flutter app. Prerequisites from
  a machine without the SDK; tap, type, Back, rebuild; the app calls a
  backend service through `adb reverse`; two stories run two emulators.

## 11. Step 6: native macOS and Windows apps

Goal: be clear and useful for apps that only run on the user's operating
system (AppKit or SwiftUI macOS apps, WPF, WinUI, WinForms), without
isolation.

- These projects keep a host-only run configuration (`category: "desktop"`,
  `services: []`). Nothing changes in the manifest.
- **Direct mode stories**: the story preview shows `HostWindowPanel`: "This
  app opens in its own window." with Start, Stop and Restart (the project
  runner), its logs below, and the status of the run. No streaming.
- **Local-container and cloud stories**: the panel says "This app runs on
  your computer only. Work on it in a Direct story to try it." and shows no
  start button.
- The agent keeps `project_app` in Direct mode (it starts and checks the
  app); it cannot see the window. Say so in the prompt paragraph for
  desktop host configurations, so the agent asks the user to check the UI
  instead of claiming it did.
- Initialization: a macOS-only or Windows-only app gets this configuration,
  not a block. `unsupported_stack` stays for what no surface covers.
- Out of scope, recorded for later: an isolated macOS VM per story with
  Lume (MIT) on Apple Silicon (Apple's license allows two macOS VMs per
  Mac); agent screenshots of host windows through ScreenCaptureKit, which
  needs the Screen Recording permission.

Done when: a SwiftUI macOS template app and a WinUI template app start and
stop from the story panel in Direct mode; the agent's prompt mentions that
it cannot see the window; other modes show the explanation.

## 12. Repository rules for the implementer

- Work in the order of the steps. Each step ships on its own and leaves
  web previews unchanged. Steps 4 and 5 share section 8: build it in step 4.
- There is no feature flag system. While a step is in progress, gate its
  surface behind the environment variable
  `BLAME_EXPERIMENTAL_SURFACES` (comma-separated: `terminal`, `display`,
  `phone-web`, `expo-go`, `ios`, `android`, `host-window`), read once in the
  desktop main process. Remove the gate when the step's "Done when" passes.
- Line budgets: `node scripts/check-line-budgets.mjs` must pass. Hard limit
  1000 lines per source file. `cline-runtime.ts` is at its 4900-line budget:
  add nothing there. `user-story-preview.tsx` (going to 1950) and
  `workspace-ipc.ts` (going to 3000) must shrink or stay equal: put new code
  in new modules.
- Tests use `node:test`. Register every new test file in its package's
  `test` script (`app`, `desktop` and `agent-runtime` list files
  explicitly).
- Typechecks: in `packages/app`, `pnpm exec tsc -p tsconfig.app.json --noEmit`;
  in other packages, `pnpm typecheck`.
- Run Prettier from the package's own directory, and only on files that
  were formatted at the starting commit.
- Never commit `PRODUCT.md`, `packages/api/database/schema.ts`, or
  `packages/api/.adonisjs/client/registry/*`.
- Commit messages: conventional style as in `git log`
  (`feat(preview): …`), no AI attribution lines.
- UI text is English, plain, without internal names (no `previewManifest`,
  no tool names). Errors say what happened and what the user can do.
- Never run commands that need the user's password; show them with an
  "Open in Terminal" action instead. Never accept SDK or Xcode licenses for
  the user.
- Pin every downloaded binary by version and SHA-256, every image by
  digest. Downloads go to Blame's data folder, never to system folders.

## 13. Third-party components

| Component | Use | License | Where it runs |
| --- | --- | --- | --- |
| ttyd | terminal server (step 1) | MIT | preview containers |
| xterm.js, `@xterm/headless` | terminal views and agent screen | MIT | app, desktop |
| TigerVNC (`Xvnc`) | virtual screen and VNC (step 3) | GPL-2.0 | display image |
| websockify | VNC over WebSocket | LGPL-3.0 | display image |
| noVNC (`@novnc/novnc`) | VNC client in the app | MPL-2.0 | app |
| Openbox, xdotool, wmctrl, ImageMagick | window manager, input, screenshots | GPL-2.0 / BSD-3 / GPL-2.0 / ImageMagick | display image |
| AXe | iOS Simulator frames, input, accessibility | MIT | Mac |
| Xcode, simctl | iOS build and simulators | Apple, installed by the user | Mac |
| Android SDK, emulator, adb | Android build and emulators | Android SDK license, accepted by the user | host |
| Expo Go | phone preview (step 2) | Expo's app, installed by the user | phone |

Check each license file at the pinned version before shipping, and keep the
GPL notices and source offers with the published images. Blame is
AGPL-3.0; the GPL tools run as separate programs inside images.

## 14. Risks

- **Private Apple frameworks** (AXe): Xcode updates can break touches and
  frames. Mitigated by the screenshot fallback and a version check; pin and
  update AXe with each Xcode release.
- **Resource use**: each booted simulator or emulator takes 1.5 to 3 GB of
  memory; the two-device limit and idle shutdown keep it bounded. Display
  previews add about 200 MB per story in the VM.
- **Host execution**: iOS and Android builds run project code (build
  scripts, CocoaPods, Gradle) on the user's computer without isolation, as
  Direct mode does. The first device preview of a project asks once:
  "Building this app runs the project's build scripts on your Mac." The
  answer is stored per project.
- **Expo Go reachability**: may need manifest rewriting; spike S2 decides.
- **Image maintenance**: three published images to keep updated (monthly
  rebuild for security updates, like the runtime images).
- **Cloud runner coupling**: terminal and display surfaces need a runner
  release; plans stay version 2 without them (D8).

## 15. Open questions

1. Should a story be able to move from a cloud runtime to local when the
   user wants a device preview, or is the message enough for now?
2. Default limit of booted devices per platform: 2, or adapt to the Mac's
   memory?
3. Should Direct mode stories get XcodeBuildMCP as an MCP server for the
   agent (build and test diagnostics on the Mac)?

## Sources

- [Vercel Sandbox concepts](https://vercel.com/docs/vercel-sandbox/concepts)
- [Firecracker and nested virtualization (iximiuz Labs)](https://labs.iximiuz.com/docs/playground-recipes/nested-virtualization)
- [AXe CLI documentation](https://docsearch.algolia.com/mcp/docs/repo/cameroncooke/axe)
- [XcodeBuildMCP overview](https://glama.ai/mcp/servers/@cameroncooke/XcodeBuildMCP/blob/db9d7d0b6dfe98f1e508a8fc1bd50840c2920eb7/docs/OVERVIEW.md)
- [XcodeBuildMCP issue 446 (Xcode 27 beta)](https://github.com/getsentry/XcodeBuildMCP/issues/446)
- [mobile-mcp](https://github.com/mobile-next/mobile-mcp)
- [Android emulator container scripts](https://docsearch.algolia.com/mcp/docs/repo/google/android-emulator-container-scripts)
- [Android emulator gRPC protos (AOSP)](https://android.googlesource.com/platform/external/qemu/+/emu-master-dev/android/android-grpc/python/aemu-grpc)
- [Build your own cloud emulator (AOSP)](https://source.android.com/docs/automotive/start/avd/cloud_emulator?hl=en)
- [Android Studio on Linux ARM64 (Fedora discussion)](https://discussion.fedoraproject.org/t/android-studio-linux-arm-support-missing/105576)
- [Expo packager proxy URL (Expo forums)](https://forums.expo.dev/t/wrong-metro-url-when-using-expo-packager-proxy-url-expo-manifest-proxy-url/66456)
- [ttyd](https://docsearch.algolia.com/mcp/docs/repo/tsl0922/ttyd)
- [Selkies](https://github.com/selkies-project/selkies)
- [Lume vs Tart (Cua)](https://cua.ai/docs/lume/guide/getting-started/comparison)


## Implementation evidence (2026-10-28)

- Terminal parser/compiler, shared ttyd session, IPC terminal view and agent tool
  are implemented. ttyd 1.7.7 static assets are pinned by SHA-256. The web parity
  corpus is unchanged. The runner source accepts plan 3; publication of runner
  0.3.0 and its image digest is still required before changing the API's pinned
  runner. Until then cloud surface capabilities remain unavailable.
- Phone/tablet web framing and matching browser/agent device emulation are
  implemented behind `phone-web`.
- S2 has **not** been validated: this Linux execution environment has no iOS or
  Android phone running Expo Go. No claim about proxy reachability can be made.
  As section 6.2 permits, the Expo Go dialog and unauthenticated device links
  remain deferred until the two physical-device checks pass.
- Experimental gates stay in place until the manual acceptance matrix for each
  surface passes on the required operating systems.

- Display: sidecar compilation, private X11 volume, shared memory, noVNC, bounded
  actions, cloud owner checks and window readiness are implemented. A local
  non-root image smoke test opened xmessage, listed its window, captured a PNG and
  clicked it. The Linux desktop build has passed typechecks. GHCR publication is
  blocked here by invalid GitHub release authentication, so the image pins remain
  empty instead of using guessed digests. The workflow publishes multi-arch signed
  images and permanent corresponding-source release assets; import its real pins
  before enabling screen previews. Electron/Tauri/GTK/Qt and cloud acceptance
  tests remain required.

- iOS source implementation: device manifest and run-configuration validation,
  one-way build mirrors, project-scoped host-build consent, prerequisites, AXe
  1.8.0 installer (verified upstream SHA-256), simulator lifecycle, Xcode builds,
  Flutter resident daemon, frame streaming with simctl fallback, input and
  accessibility tools, environment bindings, device editor and lifecycle cleanup.
  Linux unit tests cover command construction, parsing, fallback, mirrors, shared
  bindings and the two-device/idle limits. Xcode, SwiftUI, Expo and Flutter manual
  acceptance on a Mac is still outstanding; the `ios` gate is retained.

- Android source implementation: SDK/Java/acceleration prerequisites, pinned
  command-line tools 23.0 for Linux/macOS/Windows (all four archives verified
  against Google's repository metadata and SHA-256), read-only emulator instances,
  host Gradle builds, Expo/React Native/Flutter, adb reverse, bounded UI trees,
  logs, input and screenshot fallback. The gRPC descriptor is generated from the
  emulator 37.2.12 archive build 16428233 (archive SHA-256
  `b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1`).
  Tests exercise the generated client against an authenticated fake server.
  SDK components installed by sdkmanager remain governed by the user's SDK
  installation and accepted licenses; Blame does not accept licenses.
- S5 has not been run: no Vercel Sandbox credentials or existing test sandbox are
  attached to this execution environment. The managed execution container is not
  evidence about Vercel's KVM availability. Cloud device targets return
  `cloud_story` and no cloud Android support is claimed.
- Android Studio template / Expo / Flutter acceptance on macOS and Windows is
  still outstanding; the `android` gate is retained.

- Host windows: a Direct story uses the shared project runner for Start, Stop,
  Restart, status and logs. Foreground desktop commands close their runner shell
  on exit so failures and clean exits are reported. Other placements show the
  local-only explanation without a start button. Native-window agent prompts
  explicitly say that the agent cannot inspect the window. The `host-window`
  gate remains pending SwiftUI macOS / WinUI acceptance.
