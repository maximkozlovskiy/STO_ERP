#!/usr/bin/env bash
# Нові дублікати коду (jscpd) — клони, яких НЕ було в базовому коміті. Наявні (на момент вмикання
# 2026-10-22: 335 клонів, 3.43% рядків) гейт не чіпає: валить лише те, що приніс цей diff.
#
#   bash scripts/check-dupes.sh            # база — upstream гілки (@{u}), тобто те, що піде в push
#   bash scripts/check-dupes.sh <ref>      # явна база (CI: ціль PR або коміт останнього успішного прогону на push)
#
# Без валідної бази (перший push гілки, workflow_dispatch) — лише звіт, exit 0.
# Що сканується й ігнорується — .jscpd.json. Сканується РОБОЧЕ дерево, тож незакомічені правки
# теж потрапляють у порівняння.
set -u
cd "$(dirname "$0")/.."

base="${1:-}"
[ -z "$base" ] && base=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$base" ] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "jscpd: немає бази для порівняння ('${base}') — лише звіт, без гейта"
  exec pnpm exec jscpd -c .jscpd.json
fi
# Далі база — ХЕШЕМ. Git Bash (MSYS) на Windows перетворює аргумент `origin/main:.jscpd.json` на
# шлях `origin\main;.jscpd.json`: `git cat-file` падав, і скрипт мовчки переходив у «лише звіт»
# (exit 0) — prepush через `@{u}` не ловив нових клонів, а CI на Linux ловив (CI 159, 2026-10-26).
base_sha=$(git rev-parse --verify "${base}^{commit}")
# База без .jscpd.json — гейта там ще не було: перший push із гейтом лише звітує, а клони, що вже
# лежать у ньому, стають базою (рішення власника 2026-10-23: 15 клонів рядка фільтрів списків
# прийшли разом із гейтом із паралельної сесії — docs/TECH-DEBT.md §19).
if ! git cat-file -e "${base_sha}:.jscpd.json" 2>/dev/null; then
  echo "jscpd: у базі '${base}' гейта ще немає — перший push із ним, лише звіт"
  exec pnpm exec jscpd -c .jscpd.json
fi
exec pnpm exec jscpd -c .jscpd.json --baseline-from-ref "$base_sha" --fail-on-new-clones
