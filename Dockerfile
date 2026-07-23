FROM node:22.17.1-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:22.17.1-alpine

LABEL org.opencontainers.image.authors="Vast Development Method" \
      org.opencontainers.image.description="Self-hosted Model Context Protocol server for Joomla 6.x" \
      org.opencontainers.image.licenses="GPL-2.0-or-later" \
      org.opencontainers.image.source="https://github.com/joomengine/joomla-mcp" \
      org.opencontainers.image.title="JoomEngine MCP for Joomla" \
      org.opencontainers.image.vendor="Vast Development Method"

ENV NODE_ENV=production \
    JOOMLA_MCP_HEALTH_ADDRESS=127.0.0.1 \
    JOOMLA_MCP_HEALTH_HOST=127.0.0.1:3000 \
    JOOMLA_MCP_HEALTH_PATH=/healthz \
    JOOMLA_MCP_HEALTH_PORT=3000 \
    JOOMLA_MCP_HEALTH_TIMEOUT_MS=3000

WORKDIR /app

RUN addgroup -S -g 10001 joomla-mcp \
    && adduser -S -D -H -u 10001 -G joomla-mcp joomla-mcp \
    && mkdir -p /run/joomla-mcp \
    && mkdir -p /var/lib/joomla-mcp \
    && chown 10001:10001 /run/joomla-mcp /var/lib/joomla-mcp \
    && chmod 0700 /var/lib/joomla-mcp

COPY --from=build --chown=10001:10001 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 scripts/deploy/healthcheck.mjs ./scripts/deploy/healthcheck.mjs
COPY --chown=10001:10001 LICENSE ./LICENSE

USER 10001:10001

EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/scripts/deploy/healthcheck.mjs"]

ENTRYPOINT ["node", "dist/bin/joomla-mcp-http.js"]
