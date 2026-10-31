# Contributing to Blame

Thanks for helping build Blame. Bug reports, documentation fixes, and focused pull requests are all welcome. This guide covers how to propose a change and how to run Blame from source.

By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** Open an [issue](https://github.com/rchrp/Blame/issues/new/choose) with the steps to reproduce it, your platform and Blame version, and the relevant logs.
- **Suggest a feature.** Start a thread in [Discussions → Ideas](https://github.com/rchrp/Blame/discussions) so others can weigh in, or open a feature request issue.
- **Ask a question.** Use [Discussions → Q&A](https://github.com/rchrp/Blame/discussions) rather than an issue.
- **Fix something.** Issues labeled [`good first issue`](https://github.com/rchrp/Blame/labels/good%20first%20issue) and [`help wanted`](https://github.com/rchrp/Blame/labels/help%20wanted) are good places to start.
- **Report a vulnerability** privately, as described in [SECURITY.md](SECURITY.md).

## Pull requests

For a substantial feature or an architectural change, open an issue or a discussion first so we can agree on the approach before you write the code.

- Keep each pull request focused on one problem. Explain the problem, the change, and how you verified it.
- Follow the existing package boundaries. Renderer code goes through the platform and preload interfaces; backend controllers delegate application logic to services.
- Read any `AGENTS.md` file that applies to the files you change, such as [`packages/desktop/AGENTS.md`](packages/desktop/AGENTS.md).
- Add or update tests for the behavior you change, and run the [checks](#checks) before opening the pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages and pull request titles, for example `fix(preview): recover an interrupted session` or `docs: clarify local setup`.
- Keep files under the line budgets that CI enforces (`node scripts/check-line-budgets.mjs`).

Contributions are accepted under the project's [AGPL-3.0 license](LICENSE).

## Development setup

Blame is a TypeScript monorepo using [pnpm](https://pnpm.io) and [Turborepo](https://turbo.build).

### Prerequisites

- **Node.js 24**, matching CI. The root package declares Node.js 22 or later.
- **pnpm 10.33.2**, pinned in `package.json`.
- **Git** and a local **MySQL 8.4** database for the API.
- A graphical desktop session to run Electron. Local execution also needs the platform's container or VM runtime.

### Install dependencies

```bash
git clone https://github.com/rchrp/Blame.git
cd Blame
corepack enable
pnpm install --frozen-lockfile
```

If Corepack is unavailable in your Node.js installation, install the pinned pnpm version using the [pnpm installation guide](https://pnpm.io/installation).

### Configure the API

Create a local MySQL database and user, then copy the environment template:

```bash
cp packages/api/.env.example packages/api/.env
pnpm --filter @blame/api exec node ace.js generate:key
```

Edit `packages/api/.env` for your local services:

| Configuration  | Local development setup                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Database       | Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_DATABASE` to your local MySQL instance.                                |
| Origins        | Keep the API on `http://localhost:3333` and allow `http://localhost:5173` in `BETTER_AUTH_TRUSTED_ORIGINS` and `CORS_ORIGIN`.      |
| Authentication | Set `BETTER_AUTH_SECRET` to a separate random secret of at least 32 characters.                                                    |
| Telemetry      | Set `BLAME_TELEMETRY_TOKEN_SECRET` to another random secret. Configure the public and upstream endpoints for your own environment. |
| File storage   | Use `ATTACHMENTS_STORAGE_DRIVER=memory` and `BLAME_WORKSPACE_STORAGE_DRIVER=memory` for disposable development storage.            |
| Cloud previews | Keep `BLAME_CLOUD_RUNTIME_ENABLED=false` unless you are configuring the managed infrastructure.                                    |
| Model catalog  | Set `BLAME_MODEL_CATALOG_LIVE_REFRESH=false` to use the bundled catalog without live refresh.                                      |

The memory storage drivers lose uploaded content when the API process stops. Durable deployments need configured object storage.

Email/password registration requires email verification. Configure `RESEND_API_KEY` and `AUTH_EMAIL_FROM` to complete that flow against your own backend. Social sign-in, billing, transcription, and managed previews each require their corresponding service credentials when enabled. The environment template lists these integrations.

Build the API's workspace dependencies and apply migrations:

```bash
pnpm exec turbo run build --filter='@blame/api^...'
pnpm --filter @blame/api exec node ace.js migration:run --no-schema-generate
```

### Run the application

Start the API:

```bash
pnpm --filter @blame/api dev
```

In another terminal, start the desktop app:

```bash
pnpm --filter @blame/desktop dev
```

For web UI development, run the frontend instead:

```bash
pnpm exec turbo run build --filter='@blame/app^...'
pnpm --filter @blame/app dev
```

The web frontend uses `http://localhost:3333/api/v1` in development. Set `VITE_CLOUD_API_URL` to override that origin when needed.

For local browser sign-in and email verification pages, also run the website:

```bash
cp packages/vitrine/.env.example packages/vitrine/.env.local
pnpm --filter @blame/vitrine dev
```

Set `NEXT_PUBLIC_BLAME_API_URL=http://localhost:3333/api/v1` in the website environment and `BLAME_SITE_URL=http://localhost:3000` in the API environment. Add `http://localhost:3000` to `CORS_ORIGIN` for browser requests.

Use these package commands for local development. The root `pnpm dev` command currently starts the maintainer's SSH database tunnel.

### Checks

Run the checks relevant to your change before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @blame/app test
pnpm --filter @blame/desktop test
pnpm --filter @blame/agent-runtime test
```

API tests use `packages/api/.env.test`. Configure a dedicated test database before running functional tests: their setup and teardown can migrate, truncate, or reset that database.

```bash
pnpm --filter @blame/api test
```

`pnpm build` and `pnpm test` run the monorepo-wide pipelines. Individual packages also expose focused suites. See the [CI workflow](.github/workflows/ci.yml) for the checks run in CI and the [desktop documentation](packages/desktop/README.md) for packaging and runtime images.

### Self-hosting status

The development setup is not yet a turnkey self-hosted distribution. Desktop backend origins, email, telemetry, durable storage, and managed-service configuration still need deployment-specific setup. The [open-source readiness summary](docs/open-source-readiness.tex) tracks these remaining dependencies and release decisions.

## Repository layout

| Path                                                                                                                                                   | Responsibility                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`packages/app`](packages/app)                                                                                                                         | React and Vite interface shared with the desktop app                                  |
| [`packages/desktop`](packages/desktop)                                                                                                                 | Electron host, preload bridge, Git, filesystem, and runtime integration               |
| [`packages/api`](packages/api)                                                                                                                         | AdonisJS API, authentication, persistence, encrypted credentials, and hosted services |
| [`packages/agent-runtime`](packages/agent-runtime)                                                                                                     | Cline SDK integration, agent sessions, and the Light Semantic Harness                 |
| [`packages/harness-core`](packages/harness-core)                                                                                                       | Framework-independent harness contracts and reference implementations                 |
| [`packages/preview-contract`](packages/preview-contract), [`packages/preview-runtime`](packages/preview-runtime)                                       | Shared preview contracts and lifecycle coordination                                   |
| [`packages/sandbox-runner`](packages/sandbox-runner), [`packages/preview-edge`](packages/preview-edge)                                                 | Managed sandbox execution and preview gateway                                         |
| [`packages/deploy-contract`](packages/deploy-contract), [`packages/model-catalog`](packages/model-catalog), [`packages/telemetry`](packages/telemetry) | Shared deployment, model, and observability support                                   |
| [`packages/vitrine`](packages/vitrine)                                                                                                                 | Public website and download pages                                                     |
| [`packages/benchmark-runner`](packages/benchmark-runner), [`tools/terminal_bench`](tools/terminal_bench)                                               | Agent evaluation tools and benchmark evidence                                         |
