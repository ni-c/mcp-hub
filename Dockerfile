# Build stage
FROM node:26-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime: node + npx for JS servers, uv/uvx + python3 for Python servers,
# git for servers installed straight from a repository.
FROM node:26-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341
COPY --from=ghcr.io/astral-sh/uv:latest@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# The base image bundles npm 10, whose vendored deps (tar, brace-expansion,
# sigstore, ...) carry known HIGH/CRITICAL CVEs; replace it wholesale. Even
# current npm still pins two vendored packages to vulnerable releases, so
# overwrite those in place with the fixed same-major versions (identical
# dependency footprint, verified against the registry).
RUN npm install -g npm@12.0.2 \
    && npm pack brace-expansion@5.0.9 ip-address@10.3.1 --pack-destination /tmp > /dev/null \
    && tar -xzf /tmp/brace-expansion-5.0.9.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf /tmp/ip-address-10.3.1.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && rm -f /tmp/brace-expansion-5.0.9.tgz /tmp/ip-address-10.3.1.tgz

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./

ENV NODE_ENV=production \
    PORT=80 \
    CONFIG_PATH=/config/mcp.json \
    DATA_PATH=/data

# Drop root: the node image ships an unprivileged `node` user (uid 1000). The
# hub and every stdio child it spawns run as that user. A fresh named /data
# volume inherits this ownership; a bind-mounted ./data must be chowned to
# uid 1000 on the host (see docker-compose.example.yml).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 80
VOLUME /data

# Liveness only: a degraded child server intentionally does NOT mark the
# container unhealthy (health returns 503 but the hub itself is fine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
