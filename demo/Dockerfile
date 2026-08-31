# The demo image is the published hub image plus three fake servers — the same
# "extend the image" pattern the README documents for real deployments.
#
# BASE_IMAGE points at a release by default so this directory runs on its own.
# To demo the working tree instead, build the hub first and pass it in:
#   docker build -t mcp-hub:local ..
#   MCP_HUB_IMAGE=mcp-hub:local docker compose up -d --build
ARG BASE_IMAGE=ghcr.io/ni-c/mcp-hub:latest
FROM ${BASE_IMAGE}

# Under /app so Node resolves @modelcontextprotocol/server and zod from the hub's
# own /app/node_modules — the demo servers add no dependencies of their own.
COPY servers/ /app/demo-servers/
