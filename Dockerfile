# Apprua server image. Configuration comes from environment variables (see docs/configuration.md);
# data (database, code archive, instance secrets) lives in the /data volume.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --no-audit --no-fund
COPY packages packages
RUN npm run build --workspace @apprua/mcp && npm run build --workspace @apprua/server \
 && npm prune --omit=dev --workspace @apprua/server

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/server/package.json ./package.json
COPY --from=build /src/packages/server/dist ./dist
COPY --from=build /src/packages/server/assets ./assets
COPY --from=build /src/packages/mcp/dist/server.mjs /src/packages/mcp/manifest.template.json /src/packages/mcp/icon.png /src/packages/mcp/LICENSE ./mcp/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production PORT=3000 GIT_PORT=3001 SIGNPOST_PORT=3002 DATA_DIR=/data MCP_DIR=/app/mcp
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000 3001 3002
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/server.js"]
