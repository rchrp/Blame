FROM rust:1.90-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9 AS rust
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates build-essential pkg-config libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev \
    && mkdir -p /usr/local/share/blame \
    && dpkg-query -W > /usr/local/share/blame/packages.txt \
    && rm -rf /var/lib/apt/lists/*
COPY packages/preview-images/NOTICE.md /usr/local/share/blame/NOTICE.md
