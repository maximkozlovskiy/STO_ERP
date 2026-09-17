FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @sto/web... --prod=false

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=production
RUN pnpm --filter @sto/web build

# Static export lives in apps/web/out/
# Security hardening (аудит Дані/Інфра): nginx-unprivileged — non-root (uid 101), слухає :8080
# (root nginx:alpine біндив би :80 як root). Порт-мапінг host не змінюється: назовні світить лише
# Caddy, який тепер проксить web:8080 (Caddyfile) — усе внутрішнє. daemon off + non-root вбудовані у образ.
FROM nginxinc/nginx-unprivileged:alpine AS runner
COPY --from=builder /app/apps/web/out /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
