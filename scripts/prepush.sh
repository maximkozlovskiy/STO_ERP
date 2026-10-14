#!/usr/bin/env bash
# Перевірка «як у CI» перед пушем — швидка частина job `quality` (.github/workflows/ci.yml).
#
# НАВІЩО: локальні перевірки не завжди ті самі, що в CI. 2026-10-15 `packages/shared` пройшов
# збірку (`tsc -p tsconfig.cjs.json`), а CI впав на `pnpm run type-check` пакета
# (`exactOptionalPropertyTypes` вмикає лише він) — і коштував зайвий раунд CI (~40 хв).
# Тут ті самі команди, що в CI, кожна через verdict.sh; exit 0 лише якщо чисто все.
#
#   bash scripts/prepush.sh           # типи, lint, цикли, контракти й гейти (кілька хвилин)
#   bash scripts/prepush.sh --tests   # + unit-тести api/web/shared, як у CI (довше)
#
# Повні E2E сюди не входять: їх ганяє CI і — раз перед підсумком блоку — головний агент.
set -u
cd "$(dirname "$0")/.."

V="bash scripts/verdict.sh"
fail=0
step() { # step "<назва>" <команда…> — команда без власного виводу успіху → --cmd
  local name=$1; shift
  if ! $V --cmd "$name" -- "$@"; then fail=1; fi
}
gate() { # gate "<назва>" <python-скрипт і аргументи> — вивід скрипта має «N passed»/«failed»
  local name=$1; shift
  if ! python "$@" 2>&1 | $V "$name"; then fail=1; fi
}

step "type-check (api · web · shared · mobile)" pnpm run --silent type-check
step "lint (api · web · mobile)" pnpm run --silent lint
step "circular dependencies" pnpm run --silent cycles

if [ "${1:-}" = "--tests" ]; then
  (cd apps/api && npx vitest run --reporter=default --reporter=json \
    --outputFile.json=.vitest-report.json) 2>&1 | $V "api unit" || fail=1
  (cd apps/web && npx vitest run) 2>&1 | $V "web unit" || fail=1
  (cd packages/shared && npx vitest run) 2>&1 | $V "shared unit" || fail=1
fi

gate "stop-hook contract" scripts/hooks/test-check-claims.py
gate "test selector contract" scripts/test-affected-tests.py
gate "agent scopes contract" scripts/test-agent-scopes.py
gate "schema drift self-test" scripts/check-schema-drift.py --self-test
gate "skill size" scripts/check-skill-size.py
gate "doc links" scripts/check-doc-links.py
if [ -f apps/api/.vitest-report.json ]; then
  gate "spec registry" scripts/check-spec-registry.py --from-report apps/api/.vitest-report.json
else
  echo "⚠️  spec registry: немає apps/api/.vitest-report.json — запусти з --tests або повний api"
  fail=1
fi

if [ $fail -eq 0 ]; then
  echo "✅ prepush: усе як у CI quality — можна пушити"
else
  echo "❌ prepush: є падіння — пуш дасть червоний CI"
fi
exit $fail
