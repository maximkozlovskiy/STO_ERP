#!/usr/bin/env bash
# measure.sh — усі цифри проєкту ОДНИМ викликом, щоб вони не вгадувались.
#
# НАВІЩО. За аудит 2026-10 заявлена цифра розійшлася з виміряною СІМ разів:
#   59 контролерів → 37        (grep не бачив форму @ApiResponse)
#   144 роути → 60 → факт 3    (не відділяв 204/бінарні)
#   29 toast → 42              (регулярка не бачила шаблонних літералів)
#   189 тестів → 185           (сума зі звітів агентів, не вимір)
#   450 E2E → 354              (рахувались describe-блоки як тести)
#   217мс «dev-режим» → 4мс    (localhost vs 127.0.0.1 на Windows)
#   6 мутацій → 5              (grep -c "useMutation" зарахував рядок import)
#
# Спільна причина завжди одна: ОЦІНКА grep-ом замість ВИМІРУ інструментом.
# Тому цифри більше не живуть у регулярках по пам'яті — лише тут.
#
# ВИКОРИСТАННЯ: bash scripts/measure.sh [секція]
#   секції: tests | e2e | routes | bundle | docs | all (типово)

set -uo pipefail
cd "$(dirname "$0")/.."
SECTION="${1:-all}"

hr() { printf '%s\n' "────────────────────────────────────────────"; }

m_tests() {
  hr; echo "ТЕСТИ (джерело: сам раннер, не grep)"
  # ЧОМУ не `grep -c "it("`: так рахуються і коментарі, і it.each як 1 замість N.
  # Єдина правдива цифра — та, яку назвав раннер.
  local api web
  api=$( (cd apps/api && npx vitest run 2>&1) | grep -oE "Tests +[0-9]+ passed" | grep -oE "[0-9]+" | head -1 )
  web=$( (cd apps/web && npx vitest run 2>&1) | grep -oE "Tests +[0-9]+ passed" | grep -oE "[0-9]+" | head -1 )
  printf "  api unit : %s\n  web unit : %s\n" "${api:-?}" "${web:-?}"
}

m_e2e() {
  hr; echo "E2E (джерело: playwright --list, не grep по test()"
  # `grep -c "test("` рахує і test.describe → звідси «450» замість 354.
  (cd apps/web && npx playwright test --list 2>&1) | tail -1 | sed 's/^/  /'
}

m_routes() {
  hr; echo "РОУТИ БЕЗ ТИПУ (джерело: OpenAPI-документ)"
  if [[ -f packages/shared/openapi.json ]]; then
    python scripts/count-untyped-routes.py 2>/dev/null | grep -E "ВСЬОГО|по модулях" | sed 's/^/  /'
  else
    echo "  openapi.json відсутній — спершу: pnpm --filter @sto/api emit-openapi"
  fi
}

m_bundle() {
  hr; echo "БАНДЛ (джерело: size-limit + власний скрипт сторінок)"
  if [[ -d apps/web/out ]]; then
    (cd apps/web && npx size-limit 2>&1) | grep -E "Size:|Size limit:" | sed 's/^/  /'
    (cd apps/web && node scripts/check-page-budget.mjs 2>&1) | tail -1 | sed 's/^/  /'
  else
    echo "  out/ відсутній — спершу: pnpm --filter @sto/web build"
  fi
}

m_docs() {
  hr; echo "РОЗМІР ДОКУМЕНТІВ (CLAUDE.md задає ліміти — тут факт)"
  printf "  %-26s %5s рядків  (ціль ~150)\n" "MemoryManual.md" "$(wc -l < MemoryManual.md)"
  printf "  %-26s %5s рядків\n" "BUG_REPORT.md" "$(wc -l < BUG_REPORT.md)"
  echo "  скіли понад 1500 рядків (ціль: 0):"
  local any=0
  for d in .claude/skills/*/; do
    local n; n=$(wc -l < "$d/SKILL.md" 2>/dev/null || echo 0)
    (( n > 1500 )) && { printf "    %-18s %5s\n" "$(basename "$d")" "$n"; any=1; }
  done
  (( any )) || echo "    — немає"
}

case "$SECTION" in
  tests)  m_tests ;;
  e2e)    m_e2e ;;
  routes) m_routes ;;
  bundle) m_bundle ;;
  docs)   m_docs ;;
  all)    m_tests; m_e2e; m_routes; m_docs ;;   # bundle потребує build — окремо
  *) echo "невідома секція: $SECTION"; exit 1 ;;
esac
hr
