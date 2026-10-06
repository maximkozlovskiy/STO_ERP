#!/usr/bin/env bash
# verdict.sh — єдине джерело вердикту «чисто / не чисто» для прогону тестів.
#
# НАВІЩО. 2026-10-04 я відрапортував «E2E чистий», тоді як Playwright вивів
# `15 failed` (рядок 28) і `276 passed` (рядок 45). Я прочитав хвіст, побачив
# «passed» і зробив висновок. Exit code при цьому був **0** — тобто і він
# підтверджував хибний висновок.
#
# Це не недогляд одного разу, а пастка форми виводу: підсумок passed стоїть
# ПІСЛЯ підсумку failed, а хвіст читається частіше за середину. Тому вердикт
# більше не виноситься очима — його виносить цей скрипт.
#
# ВИКОРИСТАННЯ
#   <будь-яка команда> 2>&1 | bash scripts/verdict.sh [мітка]
#   bash scripts/verdict.sh --file шлях/до/лог [мітка]
#   bash scripts/verdict.sh --cmd "мітка" -- <команда...>      ← для tsc та ін.
#
# `--cmd` потрібен для інструментів, що при успіху НЕ друкують нічого (tsc, eslint
# без помилок): там вердикт дає exit code команди, а текст лише доповнює. Через pipe
# цього не видно — pipe втрачає код лівої частини, тому «тиша» трактується як
# «не розпізнано», а не як успіх.
#
# КОНТРАКТ
#   exit 0 — у виводі НЕ знайдено жодної ознаки падіння;
#   exit 1 — знайдено падіння АБО вивід не розпізнано (невідоме ≠ чисто).
#
# Друкує рівно один рядок вердикту + витяг знайдених ознак.

set -uo pipefail

LABEL="${1:-прогін}"
if [[ "${1:-}" == "--cmd" ]]; then
  LABEL="${2:?--cmd потребує мітку}"
  shift 2
  [[ "${1:-}" == "--" ]] && shift
  OUT="$("$@" 2>&1)"; RC=$?
  # Тиша + exit 0 = успіх (саме так поводиться tsc). Текст перевіряємо нижче все одно:
  # інструмент може надрукувати помилки й усе одно вийти з 0 (бувало з Playwright).
  if (( RC != 0 )); then
    echo "❌ НЕ ЧИСТО — $LABEL: exit code $RC"
    [[ -n "$OUT" ]] && head -5 <<< "$OUT"
    exit 1
  fi
  if [[ -z "${OUT//[[:space:]]/}" ]]; then
    echo "✅ ЧИСТО — $LABEL (порожній вивід + exit 0)"
    exit 0
  fi
elif [[ "${1:-}" == "--file" ]]; then
  SRC_FILE="${2:?--file потребує шлях}"
  LABEL="${3:-$(basename "$SRC_FILE")}"
  OUT="$(tr -d '\r' < "$SRC_FILE")"
else
  OUT="$(cat | tr -d '\r')"
fi

# Turborepo дописує до кожного рядка задачі префікс "@sto/web:e2e: ". Патерни нижче
# заякорені на початок рядка (`^  15 failed`), тож під turbo вони мовчали, а підсумок
# "Tasks: N successful, N total" давав «ЧИСТО» поверх `15 failed` (Playwright виходить з 0).
# Префікс знімаємо лише коли підсумок turbo є — звичайний вивід не чіпаємо.
if grep -qE "Tasks:[[:space:]]+[0-9]+ successful, [0-9]+ total" <<< "$OUT"; then
  OUT="$(sed -E 's/^@?[A-Za-z0-9_.\/-]+:[A-Za-z0-9_-]+: ?//' <<< "$OUT")"
fi

fail=0
notes=()

# ── Ознаки падіння. Кожен патерн — із реального виводу інструментів проєкту.
# Vitest/Playwright: "15 failed", "2 failed | 3113 passed"
if grep -qE "^[[:space:]]*[0-9]+ failed" <<< "$OUT"; then
  fail=1; notes+=("$(grep -oE "^[[:space:]]*[0-9]+ failed" <<< "$OUT" | head -2 | tr -d ' ')")
fi
if grep -qE "[0-9]+ failed \|" <<< "$OUT"; then
  fail=1; notes+=("$(grep -oE "[0-9]+ failed \| [0-9]+ passed" <<< "$OUT" | head -2)")
fi
# Playwright: тести, що не запустились через maxFailures — набір НЕ пройдено
if grep -qE "^[[:space:]]*[0-9]+ did not run" <<< "$OUT"; then
  fail=1; notes+=("$(grep -oE "^[[:space:]]*[0-9]+ did not run" <<< "$OUT" | head -1 | tr -d ' ')")
fi
# Vitest: блок "Failed Tests"
grep -qE "Failed Tests|⎯ Unhandled Error" <<< "$OUT" && { fail=1; notes+=("блок Failed Tests/Unhandled Error"); }
# tsc
grep -qE "error TS[0-9]+" <<< "$OUT" && { fail=1; notes+=("$(grep -cE "error TS[0-9]+" <<< "$OUT") × error TS"); }
# eslint (саме errors, не warnings)
grep -qE "✖ [0-9]+ problems? \([1-9][0-9]* errors?" <<< "$OUT" && { fail=1; notes+=("eslint errors"); }
# загальні
grep -qE "^(FAIL|ERROR)\b" <<< "$OUT" && { fail=1; notes+=("рядок FAIL/ERROR"); }

# ── Ознаки успіху — потрібні, щоб відрізнити «чисто» від «нічого не розпізнано».
ok=0
grep -qE "^[[:space:]]*(Tests|Test Files)[[:space:]]+[0-9]+ passed" <<< "$OUT" && ok=1
grep -qE "^[[:space:]]*[0-9]+ passed \(" <<< "$OUT" && ok=1
grep -qE "✖ [0-9]+ problems? \(0 errors" <<< "$OUT" && ok=1
# Turborepo (pnpm run type-check / lint / build): "Tasks:    7 successful, 7 total".
# Успіх лише коли обидва числа рівні — tsc на успіху мовчить, тож іншої ознаки немає.
# Перевіряється КОЖЕН підсумок, не лише останній: у `pnpm lint; pnpm type-check` перший
# може бути «6 із 7», а другий — «7 із 7». І «0 із 0» (фільтр не зачепив жодного пакета)
# — це «нічого не запускалось», а не успіх.
while read -r t_ok t_all; do
  [[ -z "$t_ok" ]] && continue
  if (( t_all == 0 )); then
    notes+=("turbo: 0 задач")
  elif [[ "$t_ok" == "$t_all" ]]; then
    ok=1
  else
    fail=1; notes+=("turbo: $t_ok із $t_all задач")
  fi
done < <(grep -oE "Tasks:[[:space:]]+[0-9]+ successful, [0-9]+ total" <<< "$OUT" | grep -oE "[0-9]+ successful, [0-9]+" | tr -d ',a-z')

# flaky не валить вердикт, але МУСИТЬ бути названий — інакше «0 failed»
# звучить як ідеальний результат, хоча частина тестів пройшла лише з retry.
flaky="$(grep -oE "^[[:space:]]*[0-9]+ flaky" <<< "$OUT" | head -1 | tr -d ' ')"

if (( fail )); then
  echo "❌ НЕ ЧИСТО — $LABEL: ${notes[*]}"
  exit 1
fi
if (( ! ok )); then
  echo "⚠️  НЕ РОЗПІЗНАНО — $LABEL: ознак ні падіння, ні успіху. Невідоме ≠ чисто."
  exit 1
fi
echo "✅ ЧИСТО — $LABEL${flaky:+ (УВАГА: $flaky — пройшли лише з retry)}"
exit 0
