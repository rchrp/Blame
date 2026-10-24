FROM docker/buildx-bin:0.38.0@sha256:abcf2315937f37bdb52615d1698a4696e3952e88c440a07e7552cbefbc72b1b6 AS buildx

FROM amazonlinux:2023.12.20260710.0@sha256:2d3d063f7fc9fed492a1a7286a88f9852e9b391aa7a6fe91dedbb8381e0bb5b0

ARG NODE_VERSION=24.18.1
ARG NODE_SHA256=d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0
ARG NPM_VERSION=12.0.2
ARG NPM_SHA512=b885e890b9418fa1693544d05f53e64f9a73ec194837d4258b15fecdd692347b1dd2a517b1b0cbaf9d31cd8e92c3b70956bd2ecc72833a57b4b3098f5bfa7943
ARG NPM_TAR_VERSION=7.5.21
ARG NPM_TAR_SHA512=5dd86d0af94ccb0c31a425bc604ab794e5c126950f4d1d8e1c77302cf3b71f0b09a8e1dad8e93fa09eebb86ce9f89acaa113d50b327001d123a8b5bfbcd44f1c
ARG BLAME_NPM_VERSION=11.19.0
ARG BLAME_PNPM_VERSION=10.34.4
ARG BLAME_YARN_VERSION=1.22.22
ARG BLAME_CLINE_SDK_VERSION=0.0.95
ARG DOCKER_VERSION=29.9.1
ARG DOCKER_SHA256=c158ecc55adb3afb01bbd3539ed3b997d20c26dbdc418080506cc1bf5243ff57
ARG COMPOSE_VERSION=5.6.0
ARG COMPOSE_SHA256=40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a
ARG BLAME_RUNNER_VERSION=0.2.20
ARG BLAME_RUNNER_IMAGE_DIGEST=sha256:development

RUN dnf upgrade -y \
    && dnf install -y \
      ca-certificates findutils git gzip iproute iptables-nft nftables procps-ng shadow-utils sudo tar util-linux wget xz \
    && dnf clean all \
    && curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      --output /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --strict \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && curl --fail --silent --show-error --location \
      "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" \
      --output /tmp/npm.tgz \
    && echo "${NPM_SHA512}  /tmp/npm.tgz" | sha512sum --check --strict \
    && npm install --global /tmp/npm.tgz --ignore-scripts \
    && for spec in "npm:${BLAME_NPM_VERSION}" "pnpm:${BLAME_PNPM_VERSION}" "yarn:${BLAME_YARN_VERSION}"; do \
      name="${spec%%:*}"; version="${spec#*:}"; destination="/opt/blame/package-managers/${name}/${version}"; \
      mkdir -p "${destination}/bin"; \
      npm install --prefix "${destination}" --omit=dev --ignore-scripts "${name}@${version}"; \
      ln -s "../node_modules/.bin/${name}" "${destination}/bin/${name}"; \
    done \
    && cline_destination="/opt/blame/cline/${BLAME_CLINE_SDK_VERSION}" \
    && npm install --prefix "${cline_destination}" --omit=optional --ignore-scripts \
      "@cline/sdk@${BLAME_CLINE_SDK_VERSION}" "@cline/core@${BLAME_CLINE_SDK_VERSION}" \
    && node -e 'const fs=require("fs");const path=require("path");const root=process.argv[1];const expected=process.argv[2];for(const name of ["sdk","core"]){const value=JSON.parse(fs.readFileSync(path.join(root,"node_modules","@cline",name,"package.json"),"utf8"));if(value.version!==expected)process.exit(1)}' \
      "${cline_destination}" "${BLAME_CLINE_SDK_VERSION}" \
    && curl --fail --silent --show-error --location \
      "https://registry.npmjs.org/tar/-/tar-${NPM_TAR_VERSION}.tgz" \
      --output /tmp/npm-tar.tgz \
    && echo "${NPM_TAR_SHA512}  /tmp/npm-tar.tgz" | sha512sum --check --strict \
    && for destination in \
      /usr/local/lib/node_modules/npm/node_modules/tar \
      "/opt/blame/package-managers/npm/${BLAME_NPM_VERSION}/node_modules/npm/node_modules/tar" \
      "/opt/blame/package-managers/pnpm/${BLAME_PNPM_VERSION}/node_modules/pnpm/dist/node_modules/tar"; do \
      rm -rf "${destination}"; \
      mkdir -p "${destination}"; \
      tar -xzf /tmp/npm-tar.tgz --strip-components=1 -C "${destination}"; \
    done \
    && test "$(node -p "require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version")" = "${NPM_TAR_VERSION}" \
    && test "$(node -p "require('/opt/blame/package-managers/npm/${BLAME_NPM_VERSION}/node_modules/npm/node_modules/tar/package.json').version")" = "${NPM_TAR_VERSION}" \
    && test "$(node -p "require('/opt/blame/package-managers/pnpm/${BLAME_PNPM_VERSION}/node_modules/pnpm/dist/node_modules/tar/package.json').version")" = "${NPM_TAR_VERSION}" \
    && curl --fail --silent --show-error --location \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
      --output /tmp/docker.tar.gz \
    && echo "${DOCKER_SHA256}  /tmp/docker.tar.gz" | sha256sum --check --strict \
    && tar -xzf /tmp/docker.tar.gz -C /tmp \
    && install -m 0755 /tmp/docker/docker /tmp/docker/docker-init /tmp/docker/docker-proxy /tmp/docker/dockerd /tmp/docker/containerd /tmp/docker/containerd-shim-runc-v2 /tmp/docker/runc /usr/local/bin/ \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl --fail --silent --show-error --location \
      "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      --output /usr/local/lib/docker/cli-plugins/docker-compose \
    && echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum --check --strict \
    && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose \
    && rm -rf /tmp/node.tar.xz /tmp/npm.tgz /tmp/npm-tar.tgz /tmp/docker /tmp/docker.tar.gz

COPY --chmod=0755 --from=buildx /buildx /usr/local/lib/docker/cli-plugins/docker-buildx

RUN groupadd --system blame-runtime \
    && useradd --system --create-home --gid blame-runtime --shell /usr/sbin/nologin blame-control \
    && useradd --system --create-home --gid blame-runtime --shell /bin/bash blame-project \
    && mkdir -p /opt/blame /workspace /var/lib/blame /var/log/blame \
    && chown blame-project:blame-runtime /workspace \
    && chmod 2770 /workspace \
    && chmod 0700 /var/lib/blame /var/log/blame

WORKDIR /opt/blame
COPY packages/sandbox-runner/package.json ./package.json
COPY packages/sandbox-runner/dist/blame-sandbox-runner.cjs ./dist/blame-sandbox-runner.cjs
RUN mkdir -p /opt/blame/bin \
    && ln -sf /opt/blame/dist/blame-sandbox-runner.cjs /opt/blame/bin/blame-sandbox-runner \
    && ln -sf /opt/blame/dist/blame-sandbox-runner.cjs /opt/blame/bin/blame-runnerctl \
    && chmod 0755 /opt/blame/dist/blame-sandbox-runner.cjs

ENV BLAME_RUNNER_VERSION=${BLAME_RUNNER_VERSION}
ENV BLAME_RUNNER_IMAGE_DIGEST=${BLAME_RUNNER_IMAGE_DIGEST}
ENV BLAME_CLINE_SDK_VERSION=${BLAME_CLINE_SDK_VERSION}
ENV BLAME_PACKAGE_MANAGER_ROOT=/opt/blame/package-managers
ENV PATH="/opt/blame/bin:${PATH}"

# The trusted supervisor owns dockerd and the control-plane state. Compose
# pins every project container to an unprivileged identity and never exposes
# the daemon socket to project services.
USER root
WORKDIR /workspace
