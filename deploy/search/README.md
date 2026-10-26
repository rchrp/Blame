# Blame web research

The authenticated `POST /api/v1/web/search` endpoint forwards searches to a private
SearXNG instance. All model providers use the same `search_web` tool. Page reading
runs locally in the desktop runtime, using Mozilla Readability and an isolated
Electron browser for JavaScript pages. No provider search keys are needed.

## Start SearXNG

From this directory, put a random `SEARXNG_SECRET` in a local `.env` file (for
example, generate it with `openssl rand -hex 32`), then run `docker compose up -d`.
Set `SEARXNG_VERSION` to a tested image tag or digest for production; the default
follows the upstream image. The JSON API is enabled in `settings.yml`.

Set `SEARXNG_URL=http://127.0.0.1:8888` in the API environment and restart the API.
If the API is containerized, connect both services to a private Docker network
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
page read. Search queries and page content are not written to server logs.

Google and other upstream engines may rate-limit or block the instance. Review
`docker compose logs searxng` and adjust the enabled engines when necessary. The
reader does not bypass authentication or CAPTCHA challenges. Update and retest the
container periodically as search-engine responses change.

Source metadata and citations travel in the existing conversation activity
artifacts; existing ownership checks protect their retrieval. Citation links use
`[Source name](#source-web_<id>)`; the chat resolves only ids present in its stored
tool results. Publication dates remain absent when the source does not provide one.
