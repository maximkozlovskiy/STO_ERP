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
RUN pnpm install --frozen-lockfile --filter @sto/api... --prod

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/packages/database/prisma ./packages/database/prisma

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
