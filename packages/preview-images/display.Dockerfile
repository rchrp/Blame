FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tigervnc-standalone-server websockify openbox xdotool wmctrl \
      imagemagick x11-utils fonts-dejavu fonts-noto-core fonts-noto-color-emoji python3 \
    && mkdir -p /usr/local/share/blame \
    && dpkg-query -W > /usr/local/share/blame/packages.txt \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 packages/preview-images/blame-display /usr/local/bin/blame-display
COPY packages/preview-images/NOTICE.md /usr/local/share/blame/NOTICE.md
ENV DISPLAY=:99 HOME=/tmp/blame-home
EXPOSE 6080
CMD ["blame-display", "serve"]
