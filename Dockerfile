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
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime: node + npx for JS servers, uv/uvx + python3 for Python servers,
# git for servers installed straight from a repository.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /uvx /usr/local/bin/
# The base image bundles npm 11, whose vendored deps (tar, brace-expansion,
# sigstore, ...) carry known HIGH/CRITICAL CVEs; replace it wholesale. Even
# current npm still pins three vendored packages to vulnerable releases, so
# overwrite those in place with the fixed same-major versions (identical
# dependency footprint, verified against the registry).
# This sits *before* the apt layer on purpose: it is the expensive one (three
# packages fetched and unpacked, under QEMU on arm64), it does not rot with
# time — only with the pins written here — and everything below the cache
# buster is rebuilt daily. Nothing here needs apt: `tar` is essential in the
# base image, and npm reaches the registry over Node's built-in CA store, not
# the system one (which the base image purges).
RUN npm install -g npm@12.0.2 \
    && npm pack brace-expansion@5.0.9 ip-address@10.3.1 tar@7.5.22 --pack-destination /tmp > /dev/null \
    && tar -xzf /tmp/brace-expansion-5.0.9.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf /tmp/ip-address-10.3.1.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && tar -xzf /tmp/tar-7.5.22.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/tar \
    && rm -f /tmp/brace-expansion-5.0.9.tgz /tmp/ip-address-10.3.1.tgz /tmp/tar-7.5.22.tgz \
    # Nothing here runs yarn or corepack, and each is a package manager with
    # its own dependency tree for the scanner to find something in one day.
    && rm -rf /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# A Debian security update reaches this image only if this layer is actually
# rebuilt, and on its own it never is: the base digest is pinned and the apt
# command is a constant, so the buildx cache hands back whatever was installed
# the day the layer was first built. That is not theory — libexpat1
# (CVE-2026-56408) and libssh2 (CVE-2026-7598, CVE-2026-58050) were both fixed
# in bookworm-security and both shipped in published images anyway, because a
# cached layer cannot be re-scanned into correctness and a workflow rerun does
# not touch it.
# So CI passes today's date here (see ci.yml) and the layer expires once a day.
# The value MUST appear in the command: BuildKit keys a RUN on its expanded
# command line, and a declared-but-unused ARG invalidates nothing.
ARG APT_SECURITY_EPOCH=0
RUN echo "apt index epoch: $APT_SECURITY_EPOCH" \
    && apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Ownership proof for the MCP Registry: must match server.json's name.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/mcp-hub"

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Only package.json: the version is read from it at runtime, the lockfile is
# read by nothing once the install above has happened.
COPY package.json ./

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
