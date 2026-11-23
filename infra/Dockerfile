# syntax=docker/dockerfile:1.7
FROM node:24-trixie-slim AS build
WORKDIR /app
ENV BACKEND_URL=http://api:3000 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY apps/simulators/package.json apps/simulators/
COPY packages/agent/package.json packages/agent/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && rm -rf apps/web/.next/cache

# Keep workspace symlinks and Next runtime dependencies intact.
FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 COREPACK_HOME=/opt/corepack NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY --from=build --chown=node:node /app /app
ENV COREPACK_ENABLE_NETWORK=0
USER node
EXPOSE 3000
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web"]
