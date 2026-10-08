FROM node:22-alpine AS base
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
# @sto/shared підключений як link: на теку пакета, а його package.json.main вказує на
# dist/cjs — тож без цієї збірки api не резолвить '@sto/shared' і падає з 119× TS2307.
RUN pnpm --filter @sto/shared build
RUN pnpm --filter @sto/api build

FROM node:22-alpine AS runner
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
# Prisma 7 більше не шукає схему сама: шлях до multi-file схеми (prisma/schema), до міграцій
# (prisma/migrations) і рядок підключення живуть у prisma.config.ts. Без цього файла у рантайм-
# образі падає і `prisma generate` нижче («Could not find Prisma Schema»), і `prisma migrate
# deploy`, який інсталятор запускає при First-Run/Update.
COPY --from=builder /app/packages/database/prisma.config.ts ./packages/database/prisma.config.ts
# Моделі розпізнавання (ukr+eng, 7.7 МБ) для OCR сканів і фото накладних. Їдуть УСЕРЕДИНІ
# образу → автоматично потрапляють у docker save .tar.gz офлайн-інсталятора (ADR-003),
# тож змін в installer/ не потрібно. Без цього рядка OCR кине OcrModelsMissingError.
COPY --from=builder /app/apps/api/assets ./apps/api/assets

# Generate the Prisma client (query engine binary is bundled — no network needed),
# then strip dev dependencies to keep the runtime image lean. The prisma CLI is a
# PROD dependency of @sto/database (not a devDep) precisely so `pnpm prune --prod`
# keeps it — the installer runs `docker compose exec/run api npx prisma migrate deploy`
# (First-Run/Update) offline, which resolves the local CLI (no registry fetch).
RUN pnpm --filter @sto/database exec prisma generate
# --config.confirmModulesPurge=false: pnpm 10+ без TTY відмовляється чистити node_modules
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) — у Docker TTY немає за визначенням.
# --ignore-scripts: після видалення devDependencies pnpm запускає root-`prepare` → husky,
# якого вже немає → ELIFECYCLE. У прод-образі git-хуки не потрібні за визначенням.
# Prune від КОРЕНЯ у pnpm-воркспейсі зрізає симлінки робочих пакетів разом із devDeps:
# apps/api/node_modules порожнів, і прод-залежності (@napi-rs/canvas, tesseract.js) зникали
# з образу, хоч і лишались у .pnpm-сховищі. Тому прунимо РЕКУРСИВНО (-r), щоб pnpm знав
# про залежності кожного пакета воркспейсу.
# НЕ `pnpm prune`: у воркспейсі він працює лише від кореня і зрізає симлінки робочих
# пакетів разом із devDeps — apps/api/node_modules порожнiв, а прод-залежності
# (@napi-rs/canvas, tesseract.js) зникали з образу, хоч і лишались у .pnpm-сховищі.
# Повторний install із --prod дає коректне прод-дерево для всього воркспейсу.
RUN pnpm install --frozen-lockfile --filter @sto/api... --prod --ignore-scripts --config.confirmModulesPurge=false

# Security hardening (аудит Дані/Інфра): не працювати від root. `node`-user (uid 1000) уже є в
# node:22-alpine. chown /app ПІСЛЯ install/generate/prune (усі потребують root-запису у node_modules),
# щоб рантайм-процес і `docker compose exec/run api npx prisma migrate deploy` (installer First-Run/Update)
# писали від node. $HOME=/home/node писабельний → prisma engine temp/cache без проблем.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
