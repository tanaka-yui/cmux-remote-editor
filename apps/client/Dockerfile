# Client: build the Vite/React PWA, then serve the static output with nginx.
# Build context is the repository root (see compose.yml).
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/client/package.json ./apps/client/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile --filter @tanaka-yui/cmux-remote-editor-client...
COPY apps/client ./apps/client
RUN pnpm --filter @tanaka-yui/cmux-remote-editor-client build

FROM nginx:latest
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/client/dist /usr/share/nginx/html
EXPOSE 80
