# Bun server: the cmux WebSocket bridge.
# Build context is the repository root (see compose.yml).
FROM oven/bun:1 AS deps
WORKDIR /app
COPY apps/server/package.json ./
RUN bun install --production

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server/package.json ./
COPY apps/server/src ./src
ENV PORT=3456
EXPOSE 3456
CMD ["bun", "run", "src/index.ts"]
