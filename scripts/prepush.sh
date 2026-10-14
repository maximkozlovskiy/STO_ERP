#!/usr/bin/env bash
# Перевірка «як у CI» перед пушем — швидка частина job `quality` (.github/workflows/ci.yml).
#
# НАВІЩО: локальні перевірки не завжди ті самі, що в CI. 2026-10-15 `packages/shared` пройшов
# збірку (`tsc -p tsconfig.cjs.json`), а CI впав на `pnpm run type-check` пакета
# (`exactOptionalPropertyTypes` вмикає лише він) — і коштував зайвий раунд CI (~40 хв).
# Тут ті самі команди, що в CI, кожна через verdict.sh; exit 0 лише якщо чисто все.
#
#   bash scripts/prepush.sh           # типи, lint, цикли, контракти й гейти (кілька хвилин)
#   bash scripts/prepush.sh --tests   # + unit-тести api (з порогами покриття)/web/shared, як у CI
#
# Свідомо НЕ входять:
#   - `prisma generate` — на Windows переписує клієнт під запущеним dev-сервером API; замість
#     нього перевіряється, що згенерований клієнт не старший за схему;
#   - `pnpm run deadcode` — у CI звітний (`knip --no-exit-code`), червоним не буває;
#   - повні E2E — їх ганяє CI і (раз перед підсумком блоку) головний агент.
set -u
cd "$(dirname "$0")/.."

V="bash scripts/verdict.sh"
# Windows Git Bash має `python`, Linux/CI — часто лише `python3`.
PY=python; command -v python >/dev/null 2>&1 || PY=python3
fail=0
step() { # step "<назва>" <команда…> — вердикт дає exit code І текст виводу (verdict.sh --cmd)
  local name=$1; shift
  if ! $V --cmd "$name" -- "$@"; then fail=1; fi
}

# Згенерований Prisma-клієнт старший за схему → tsc локально перевіряє не ті типи, що CI
# (CI генерує клієнт заново на кожен прогін).
client_dts=$(cd packages/database && node -e "const p=require('path');process.stdout.write(
  p.join(p.dirname(require.resolve('@prisma/client')),'..','..','.prisma','client','index.d.ts'))" \
  2>/dev/null)
if [ -z "$client_dts" ] || [ ! -f "$client_dts" ]; then
  echo "❌ НЕ ЧИСТО — prisma client: не знайдено згенерований клієнт (pnpm --filter @sto/database exec prisma generate)"
  fail=1
elif [ -n "$(find packages/database/prisma/schema -name '*.prisma' -newer "$client_dts" -print -quit)" ]; then
  echo "❌ НЕ ЧИСТО — prisma client: схема новіша за клієнт — pnpm --filter @sto/database exec prisma generate"
  fail=1
fi

# --force: CI кешу turbo не має, а локальний кеш не бачить входів поза пакетом (згенерований
# Prisma-клієнт у node_modules) — «cache hit» тоді повторює старий вердикт.
step "type-check (api · web · shared · mobile)" pnpm run --silent type-check --force
step "lint (api · web · mobile)" pnpm run --silent lint --force
step "circular dependencies" pnpm run --silent cycles

if [ "${1:-}" = "--tests" ]; then
  # Оточення як у job `quality`: БД і Redis там НЕМАЄ, тож integration-специ йдуть у skip (без
  # REQUIRE_DB) — локально вони інакше ходили б у dev-базу, писали б у неї й могли б падати на
  # її даних. Склад кейсів у звіті від цього не змінюється. --coverage — це крок
  # «Coverage thresholds (api)» в одному прогоні з unit-тестами, а не окремим.
  (cd apps/api && DATABASE_URL=postgresql://sto:sto@127.0.0.1:1/sto_erp \
    REDIS_URL=redis://127.0.0.1:1 npx vitest run --coverage --reporter=default \
    --reporter=json --outputFile.json=.vitest-report.json) 2>&1 | $V "api unit + coverage" || fail=1
  (cd apps/web && npx vitest run) 2>&1 | $V "web unit" || fail=1
  (cd packages/shared && npx vitest run) 2>&1 | $V "shared unit" || fail=1
fi

step "stop-hook contract" $PY scripts/hooks/test-check-claims.py
step "test selector contract" $PY scripts/test-affected-tests.py
step "agent scopes contract" $PY scripts/test-agent-scopes.py
step "schema drift self-test" $PY scripts/check-schema-drift.py --self-test
step "skill size" $PY scripts/check-skill-size.py
step "doc links" $PY scripts/check-doc-links.py

report=apps/api/.vitest-report.json
if [ ! -f "$report" ]; then
  echo "❌ НЕ ЧИСТО — spec registry: немає $report — запусти з --tests або повний api"
  fail=1
elif [ -n "$(find apps/api/src -name '*.spec.ts' -newer "$report" -print -quit)" ]; then
  # Гейт A порівнює звіт із baseline: спек, змінений після звіту, у старому звіті не видно.
  echo "❌ НЕ ЧИСТО — spec registry: $report старший за змінені спеки — запусти з --tests"
  fail=1
else
  step "spec registry" $PY scripts/check-spec-registry.py --from-report "$report"
fi

if [ $fail -eq 0 ]; then
  echo "✅ prepush: усе як у CI quality — можна пушити"
else
  echo "❌ prepush: є падіння — пуш дасть червоний CI"
fi
exit $fail
