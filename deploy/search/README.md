# Blame web research

The authenticated `POST /api/v1/web/search` endpoint forwards searches to a private
SearXNG instance. All model providers use the same `search_web` tool. Page reading
runs locally in the desktop runtime, using Mozilla Readability and an isolated
Electron browser for JavaScript pages. No provider search keys are needed.

## Dokploy: GitHub application + Dockerfile

Deploy SearXNG as an **Application** connected to the Blame GitHub repository,
using [`Dockerfile`](./Dockerfile), like the other Blame packages. Configuration
is copied into the image from [`settings.yml`](./settings.yml); no Docker Compose
service or manual File Mount is needed for Dokploy.

Use the existing Blame project/environment and deployment server:

| Setting | Value |
| --- | --- |
| Application name | Web Search |
| Source | GitHub, the same Blame repository/connection as Backend |
| Branch | `main` |
| Build path | `/` |
| Build type | Dockerfile |
| Dockerfile | `deploy/search/Dockerfile` |
| Docker context | `./` (repository root) |
| Build stage | `production` |
| Watch paths | `deploy/search/**` |
| Container port | `8080` (internal only) |
| Domains / published ports | None |
| Runtime environment | `SEARXNG_SECRET=<random secret>` |

Generate the secret with `openssl rand -hex 32` and save it in Dokploy Environment,
not in Git or build arguments. The image pins a tested upstream version/digest and
includes a health check. Its Dockerfile-specific ignore file restricts the build
context to this service's files. Reuse Backend's build server and registry when
building on a separate server. Enable automatic deployments on pushes affecting
`deploy/search/**`; settings changes then follow the normal GitHub workflow.

Keep the application on `dokploy-network`, as the existing Backend is. Add a named
volume for `/var/cache/searxng` if search cache should survive deployments; do not
mount `/etc/searxng`, because that would hide the versioned settings in the image.
Deploy Web Search, wait for it to become healthy, then add to Backend Environment
and redeploy Backend:

```dotenv
SEARXNG_URL=http://blame-searxng-b8mbdj:8080
```

The current Web Search **appName** is `blame-searxng-b8mbdj`, also its Docker
service DNS name. For another installation, replace it with that application's
actual appName returned by Dokploy; the display name may differ. `127.0.0.1` inside Backend refers to
Backend itself. There is no public SearXNG domain or port `8888` to configure.
Other services on `dokploy-network` can also reach this internal endpoint; the
network is not exclusive to Backend.

To check connectivity, run this in the **Backend container terminal**:

```sh
node -e 'fetch(process.env.SEARXNG_URL + "/search?q=Mozilla+Readability&format=json").then(async r => { if (!r.ok) throw new Error("HTTP " + r.status); const d = await r.json(); console.log({results: d.results.length, unavailable: d.unresponsive_engines}); }).catch(e => { console.error(e.message); process.exitCode = 1; })'
```

Then ask the Blame agent to search the web to verify the authenticated API path
and source display together. See [Dokploy Dockerfile build settings](https://docs.dokploy.com/docs/core/applications/build-type)
and [application environment and volumes](https://docs.dokploy.com/docs/core/applications/advanced).

## Local Docker / standalone server

From this directory, put a random `SEARXNG_SECRET` in a local `.env` file (for
example, generate it with `openssl rand -hex 32`), then run `docker compose up -d`.
Set `SEARXNG_VERSION` to a tested image tag or digest for production; the default
follows the upstream image. The JSON API is enabled in `settings.yml`.

Set `SEARXNG_URL=http://127.0.0.1:8888` in the API environment and restart the API.
For a containerized API outside Dokploy, connect both services to a private Docker network
and use `http://searxng:8080` instead. Do not expose SearXNG directly to clients.
The compose file binds only the host loopback interface.

The built-in public-instance limiter is disabled because Blame authenticates and
limits access: 30 searches/minute and 2 concurrent searches per account, with 16
concurrent searches per API process. These limits are process-local; a horizontally
scaled API should also impose a shared limit at its gateway. Valkey is not required
for this private configuration. Missing configuration returns HTTP 503 explicitly.

## Verify and operate

Check the private service with:

```sh
curl -fsS 'http://127.0.0.1:8888/search?q=Mozilla+Readability&format=json'
```

Then use `search_web` in a Blame conversation. The response contains the returned
result count, source metadata, and any unavailable engines. A partial response is
displayed as partial, and zero returned sources is not presented as a successful
page read. The Blame endpoint does not log search queries or page content. SearXNG engine
diagnostics may contain queries; restrict access to those logs and their retention.

Google and other upstream engines may rate-limit or block the instance. Review
`docker compose logs searxng` and adjust the enabled engines when necessary. The
reader does not bypass authentication or CAPTCHA challenges. Update and retest the
container periodically as search-engine responses change.

Source metadata and citations travel in the existing conversation activity
artifacts; existing ownership checks protect their retrieval. Citation links use
`[Source name](#source-web_<id>)`; the chat resolves only ids present in its stored
tool results. Publication dates remain absent when the source does not provide one.

## Runtime and UI contract

Provider-native search is disabled both in tool policies and at the provider
transport boundary (OpenAI, Anthropic, Gemini/Vertex and compatible functions).
Claude Code remains a model-only bridge, with Blame tools forwarded through MCP.
Search results use stable URL-based ids; reading a redirect preserves the original
id and records its final URL. The source drawer separates found, consulted and
cited sources. A snippet can be cited without being presented as a consulted page.

The local reader accepts public HTTP(S) text pages on standard ports, limits HTML
to 5 MB and extracted text to 50,000 characters, and revalidates every redirect.
Sparse HTML triggers Electron in auto mode; `browser` forces rendering and `http`
skips it. Electron uses a separate, temporary session without application cookies,
Node access, downloads or permissions. A DNS-pinned proxy also protects browser
subrequests from private network access. Rendering is limited to two pages at once.
HTTP errors, unsupported files and unavailable browser rendering remain explicit
failures or partial reads. The reader cannot unlock paywalls or sign in to sites.

Regression checks:

```sh
pnpm --filter @blame/api exec node ace test unit --files='tests/unit/web_search.spec.ts'
pnpm --filter @blame/agent-runtime build
node --test packages/agent-runtime/dist/web-research.test.js
node --test --experimental-strip-types packages/desktop/src/main/web-research-proxy.test.ts
pnpm --filter @blame/desktop test:web-research
node --test --experimental-strip-types packages/app/src/components/chat/web-research/web-research-data.test.ts
```

Run these commands from the repository root. The Electron smoke test intercepts
its HTTPS fixture to verify actual JavaScript hydration, Readability extraction,
sandboxing, session isolation and cleanup without depending on a public site.
The proxy tests separately exercise network restrictions and cancellation.
