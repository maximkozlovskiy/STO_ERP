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

# Незалежні кроки йдуть ПАРАЛЕЛЬНО у фоні: кожен пише свій вивід і код у власні файли,
# після `wait` усе друкується в порядку запуску, а `fail` зводиться з кодів — вивід
# стабільний, хоч кроки й закінчуються в довільному порядку.
OUT_DIR="$(mktemp -d)"; trap 'rm -rf "$OUT_DIR"' EXIT
n_bg=0
bg() { # bg "<назва>" <команда…> — вердикт дає exit code І текст виводу (verdict.sh --cmd)
  n_bg=$((n_bg + 1))
  local id; id=$(printf '%02d' "$n_bg")
  ( $V --cmd "$1" -- "${@:2}" > "$OUT_DIR/$id.out" 2>&1; echo $? > "$OUT_DIR/$id.rc" ) &
}
collect() { # друкує вивід фонових кроків у порядку запуску й зводить їхні коди у fail
  wait
  local f rc
  for f in "$OUT_DIR"/*.out; do
    [ -e "$f" ] || continue
    cat "$f"
    rc=$(cat "${f%.out}.rc" 2>/dev/null || echo 1)
    [ "$rc" = 0 ] || fail=1
    rm -f "$f" "${f%.out}.rc"
  done
}
step() { # step "<назва>" <команда…> — те саме, але на передньому плані
  local name=$1; shift
  if ! $V --cmd "$name" -- "$@"; then fail=1; fi
}

# Згенерований Prisma-клієнт старший за схему → tsc локально перевіряє не ті типи, що CI
# (CI генерує клієнт заново на кожен прогін).
client_dts=$(cd packages/database && node -e "const p=require('path');process.stdout.write(
  p.join(p.dirname(require.resolve('@prisma/client')),'..','..','.prisma','client','index.d.ts'))"   2>/dev/null)
if [ -z "$client_dts" ] || [ ! -f "$client_dts" ]; then
  echo "❌ НЕ ЧИСТО — prisma client: не знайдено згенерований клієнт (pnpm --filter @sto/database exec prisma generate)"
  fail=1
elif [ -n "$(find packages/database/prisma/schema -name '*.prisma' -newer "$client_dts" -print -quit)" ]; then
  echo "❌ НЕ ЧИСТО — prisma client: схема новіша за клієнт — pnpm --filter @sto/database exec prisma generate"
  fail=1
fi

# type-check і lint — ОДИН виклик turbo, а не два паралельні: обидві задачі мають
# `dependsOn: ["^build"]`, і два одночасні `turbo run … --force` збирали б `packages/shared`
# двічі в той самий dist. Один граф збирає залежності раз, а задачі пакетів іде паралельно.
# --continue: падіння type-check не обриває lint — у звіті видно обидва.
# --force: CI кешу turbo не має, а локальний кеш не бачить входів поза пакетом (згенерований
# Prisma-клієнт у node_modules) — «cache hit» тоді повторює старий вердикт.
bg "type-check · lint (api · web · shared · mobile)"   pnpm exec turbo run type-check lint --force --continue --output-logs=errors-only
bg "circular dependencies" pnpm run --silent cycles
# Нові клони проти @{u} — рівно те, що піде в push (CI на push порівнює з комітом останнього успішного прогону).
bg "copy-paste (нові клони)" bash scripts/check-dupes.sh
bg "verdict.sh self-test" bash scripts/verdict.sh --self-test
bg "stop-hook contract" $PY scripts/hooks/test-check-claims.py
bg "skill-before-edit hook contract" $PY scripts/hooks/test-require-skill.py
bg "test selector contract" $PY scripts/test-affected-tests.py
bg "agent scopes contract" $PY scripts/test-agent-scopes.py
bg "schema drift self-test" $PY scripts/check-schema-drift.py --self-test
bg "skill size" $PY scripts/check-skill-size.py
bg "doc links" $PY scripts/check-doc-links.py
# Подвійно закодований UTF-8 (UTF-8, прочитаний як cp1251) — 2026-10-18 жив у DTO й Swagger місяцями.
bg "mojibake" $PY scripts/check-mojibake.py
# Кириличні запасні тексти в спільному коді web (`?? 'Помилка'`, `t('key', '…')`, типовий проп) —
# в англійському інтерфейсі лишались українськими (TECH-DEBT §15 п. 2).
bg "cyrillic fallbacks (web)" bash -c "$PY scripts/check-cyrillic-fallbacks.py --self-test && $PY scripts/check-cyrillic-fallbacks.py"
# Що бачить `next build` В ОБРАЗІ: файли, виключені .dockerignore, не мають бути потрібні збиранню
# (2026-10-16 CI docker-build упав на TS2307, хоча локальні tsc були чисті).
bg "docker context (web)" $PY scripts/check-docker-context.py
collect

if [ "${1:-}" = "--tests" ]; then
  # Після фонових кроків, а не разом із ними: unit-набори й turbo ділили б ті самі ядра.
  # Оточення як у job `quality`: БД і Redis там НЕМАЄ, тож integration-специ йдуть у skip (без
  # REQUIRE_DB) — локально вони інакше ходили б у dev-базу, писали б у неї й могли б падати на
  # її даних. Склад кейсів у звіті від цього не змінюється. --coverage — це крок
  # «Coverage thresholds (api)» в одному прогоні з unit-тестами, а не окремим.
  (cd apps/api && DATABASE_URL=postgresql://sto:sto@127.0.0.1:1/sto_erp     REDIS_URL=redis://127.0.0.1:1 npx vitest run --coverage --reporter=default     --reporter=json --outputFile.json=.vitest-report.json) 2>&1 | $V "api unit + coverage" || fail=1
  (cd apps/web && npx vitest run) 2>&1 | $V "web unit" || fail=1
  (cd packages/shared && npx vitest run) 2>&1 | $V "shared unit" || fail=1
fi

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

# Нагадування, не блокування: MemoryManual.md оновлюється вручну після кожного блоку (CLAUDE.md,
# крок 3), і 2026-10-16 він простояв день із датою попереднього, хоча за день пройшло п'ять блоків.
mm_date=$(sed -n 's/^Дата:[[:space:]]*\([0-9-]\{10\}\).*/\1/p' MemoryManual.md | head -1)
last_feat=$(git log -1 --format=%cs -E --grep='^(feat|fix)(\(|:)' 2>/dev/null)
if [ -n "$mm_date" ] && [ -n "$last_feat" ] && [[ "$mm_date" < "$last_feat" ]]; then
  echo "⚠️  MemoryManual.md: «Дата: $mm_date» старша за останній feat/fix ($last_feat) — онови «Поточний стан»"
fi

if [ $fail -eq 0 ]; then
  echo "✅ prepush: усе як у CI quality — можна пушити"
else
  echo "❌ prepush: є падіння — пуш дасть червоний CI"
fi
exit $fail
