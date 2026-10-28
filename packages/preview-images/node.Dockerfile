FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libgtk-3-0 libgbm1 libasound2 libxss1 libxshmfence1 \
      libx11-xcb1 libdrm2 libatk-bridge2.0-0 dbus-x11 \
    && mkdir -p /usr/local/share/blame \
    && dpkg-query -W > /usr/local/share/blame/packages.txt \
    && rm -rf /var/lib/apt/lists/*
COPY packages/preview-images/NOTICE.md /usr/local/share/blame/NOTICE.md
