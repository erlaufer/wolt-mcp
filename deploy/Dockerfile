# wolt-mcp as a remote (Streamable HTTP) server. Build from the repo root:
#   docker build -f deploy/Dockerfile -t wolt-mcp .
# State (Wolt tokens, OAuth tokens, saved location) lives in the /data volume.
FROM node:22-alpine

WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY mcp/server.mjs ./
COPY mcp/lib ./lib

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

ENV NODE_ENV=production \
    WOLT_STATE_DIR=/data \
    WOLT_HTTP_HOST=0.0.0.0 \
    WOLT_HTTP_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

CMD ["node", "server.mjs", "--http"]
