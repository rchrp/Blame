# Build from the repository root, like the other Blame Dokploy applications.
# Pin the upstream image so a Git deployment always uses the tested version.
FROM docker.io/searxng/searxng:2026.10.25-54ca1d9cf@sha256:23482d8ecf7ddf66029479468ea04c1bb11d2b65785a17a7e629e2ffd13296ca AS production

# GHCR associates packages with this repository, not the upstream SearXNG repo.
LABEL org.opencontainers.image.source="https://github.com/rchrp/Blame"

# Configuration travels with the image; SEARXNG_SECRET is supplied at runtime.
COPY --chown=searxng:searxng deploy/search/settings.yml /etc/searxng/settings.yml

ENV GRANIAN_HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/searxng/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).close()"]
