# Build stage
#
# node:24-bookworm-slim is the ACTIVE LTS line, not the newest tag, and it is the
# line the CI test matrix covers. Node 26 is still Current, and libraries check:
# oidc-provider warns "Unsupported runtime" on any build where process.release.lts
# is unset, which is every non-LTS build.
# What keeps this honest is a comparison, not a version number written down here:
# `node:lts-bookworm-slim` and `node:24-bookworm-slim` MUST resolve to the same
# digest. The day 24 leaves LTS they diverge, and that is visible; a hardcoded
# version in a comment is not. Verified 2026-09-01: both resolve to the digest
# below, Node 24.20.0.
# Refresh the digest and re-run that comparison together — a stale tag is
# invisible if only the digest is re-resolved.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime: node + npx for JS servers, uv/uvx + python3 for Python servers,
# git for servers installed straight from a repository.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# The base image bundles npm 11, whose vendored deps (tar, brace-expansion,
# sigstore, ...) carry known HIGH/CRITICAL CVEs; replace it wholesale. Even
# current npm still pins three vendored packages to vulnerable releases, so
# overwrite those in place with the fixed same-major versions (identical
# dependency footprint, verified against the registry).
RUN npm install -g npm@12.0.2 \
    && npm pack brace-expansion@5.0.9 ip-address@10.3.1 tar@7.5.22 --pack-destination /tmp > /dev/null \
    && tar -xzf /tmp/brace-expansion-5.0.9.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf /tmp/ip-address-10.3.1.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && tar -xzf /tmp/tar-7.5.22.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/tar \
    && rm -f /tmp/brace-expansion-5.0.9.tgz /tmp/ip-address-10.3.1.tgz /tmp/tar-7.5.22.tgz

# Ownership proof for the MCP Registry: must match server.json's name.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/mcp-hub"

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
