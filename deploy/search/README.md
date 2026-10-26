# Blame web research

The authenticated `POST /api/v1/web/search` endpoint forwards searches to a private
SearXNG instance. All model providers use the same `search_web` tool. Page reading
runs locally in the desktop runtime, using Mozilla Readability and an isolated
Electron browser for JavaScript pages. No provider search keys are needed.

## Dokploy

Use [`docker-compose.dokploy.yml`](./docker-compose.dokploy.yml) as a standalone
Docker Compose deployment. It joins the existing `dokploy-network`, uses the
internal service name `blame-searxng`, and publishes no host ports or Traefik route.
The API must share that network. In this installation, the existing `Backend`
application already does.

1. In the same Dokploy project/environment and on the same server as the API,
   create a **Docker Compose** service named **Web Search**. Select **Docker
   Compose**, not Docker Stack, and use the **Raw** source. Paste the contents of
   `docker-compose.dokploy.yml` into its Compose editor.
2. In **Environment**, add `SEARXNG_SECRET=<random secret>` (generate one with
   `openssl rand -hex 32`). Set `SEARXNG_VERSION` to a tested SearXNG tag for
   production; the default follows `latest`. Save the environment.
3. In **Advanced > Mounts**, create a **File Mount** named
   `searxng-settings.yml`, with the contents of [`settings.yml`](./settings.yml).
   The Compose file mounts `../files/searxng-settings.yml` read-only at
   `/etc/searxng/settings.yml`. Use Dokploy's **Preview Compose** to check this
   mount and the shared `dokploy-network` before deploying.
4. Leave **Domains** empty and **Isolated Deployments** disabled for this Compose
   service, so it uses the explicitly declared shared network. Deploy **Web
   Search** and verify its logs show a running service.
5. In **Backend > Environment**, add the following without replacing the other
   variables, then redeploy **Backend**:

   ```dotenv
   SEARXNG_URL=http://blame-searxng:8080
   ```

`127.0.0.1` inside the API container refers to the API container itself. Use the
service URL above for Dokploy. No public SearXNG domain or port `8888` is required.
The shared network is internal to Docker but also reachable by other services on
`dokploy-network`; it is not exclusive to the API. A dedicated network can replace
it if both services are configured to join that network.

Keep the configuration in Dokploy's File Mounts: a bind mount into a Git checkout
can become empty when Dokploy reclones the repository during automatic deployment.
After changing `settings.yml` in this repository, update its Dokploy File Mount
and redeploy Web Search. References: [Dokploy Compose configuration and
mounts](https://docs.dokploy.com/docs/core/docker-compose), [network and domain
handling](https://docs.dokploy.com/docs/core/docker-compose/domains).

To check connectivity, run this in the **Backend container terminal**:

```sh
node -e 'fetch(process.env.SEARXNG_URL + "/search?q=Mozilla+Readability&format=json").then(async r => { if (!r.ok) throw new Error("HTTP " + r.status); const d = await r.json(); console.log({results: d.results.length, unavailable: d.unresponsive_engines}); }).catch(e => { console.error(e.message); process.exitCode = 1; })'
```

Then ask the Blame agent to search the web to verify the authenticated API path
and source display together.

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
