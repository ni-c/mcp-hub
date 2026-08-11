# Build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm ci --omit=dev

# Runtime: node + npx for JS servers, uv/uvx + python3 for Python servers,
# git for servers installed straight from a repository.
FROM node:22-bookworm-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
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
  CMD curl -s "http://localhost:${PORT}/health" > /dev/null || exit 1

CMD ["node", "dist/index.js"]
