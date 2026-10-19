# =============================================================================
# Dockerfile for @blame/vitrine (Next.js)
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:22-alpine AS base

RUN apk add --no-cache libc6-compat python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS builder

# Copy workspace configuration
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/

# Copy the vitrine package manifest first for better dependency layer caching
COPY packages/vitrine/package.json ./packages/vitrine/package.json
COPY packages/hero-scene/package.json ./packages/hero-scene/package.json
COPY packages/pricing-card/package.json ./packages/pricing-card/package.json

# Install only the vitrine workspace dependencies
RUN pnpm install --frozen-lockfile --filter @blame/vitrine...

# Copy the vitrine source and the workspace packages it compiles from source
COPY packages/hero-scene/ ./packages/hero-scene/
COPY packages/pricing-card/ ./packages/pricing-card/
COPY packages/vitrine/ ./packages/vitrine/

# Increase memory limit for the build process
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Force cache bust to avoid stale Next.js build layers on Dokploy
RUN rm -rf packages/vitrine/.next packages/vitrine/out

# Build the vitrine app
RUN pnpm --filter @blame/vitrine build

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM node:22-alpine AS production

WORKDIR /app

RUN apk add --no-cache libc6-compat \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Copy workspace configuration
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/
COPY packages/vitrine/package.json ./packages/vitrine/package.json
COPY packages/hero-scene/package.json ./packages/hero-scene/package.json
COPY packages/pricing-card/package.json ./packages/pricing-card/package.json

# Install production dependencies only for the vitrine app
RUN pnpm install --prod --frozen-lockfile --filter @blame/vitrine...

# Copy the built Next.js app and runtime assets
COPY --from=builder --chown=node:node /app/packages/vitrine/.next ./packages/vitrine/.next
COPY --from=builder --chown=node:node /app/packages/vitrine/public ./packages/vitrine/public
COPY --from=builder --chown=node:node /app/packages/vitrine/next.config.ts ./packages/vitrine/next.config.ts
COPY --from=builder --chown=node:node /app/packages/vitrine/package.json ./packages/vitrine/package.json

USER node

WORKDIR /app/packages/vitrine

EXPOSE 3000

CMD ["node", "node_modules/next/dist/bin/next", "start"]
