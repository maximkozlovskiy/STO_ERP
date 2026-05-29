FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @sto/api... --prod=false

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN pnpm --filter @sto/database exec prisma generate
RUN pnpm --filter @sto/api build

FROM node:20-alpine AS runner
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
# Install WITH dev deps so the prisma CLI is available for `prisma generate`.
# We prune to production deps afterwards (see below). Cross-stage copying of the
# generated client is unreliable under pnpm's symlinked layout (the client lives
# in the .pnpm virtual store, not /app/node_modules/.prisma), so we regenerate
# here against the runner's own node_modules — every consumer (apps/api,
# packages/database) then resolves @prisma/client correctly.
RUN pnpm install --frozen-lockfile --filter @sto/api... --prod=false

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/database/prisma ./packages/database/prisma

# Generate the Prisma client (query engine binary is bundled — no network needed),
# then strip dev dependencies to keep the runtime image lean.
RUN pnpm --filter @sto/database exec prisma generate
RUN pnpm prune --prod

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
