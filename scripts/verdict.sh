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
#   bash scripts/verdict.sh --self-test                        ← контракт на реальних зразках
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
#
# Вивід у ВСІХ режимах лежить у тимчасовому файлі, і кожна ознака — `grep … "$F"`, а не
# here-string по змінній: під git-хуком pre-push (процес без консолі) підстановка `$(…)` з
# великим виводом нативної програми зависала назавжди — lint із ~3800 попередженнями стояв
# 20+ хв, хоча сам завершувався за хвилину (2026-10-16); квадратична заміна `${OUT//…/}` на
# ~600 КБ мала той самий ефект. Файл + grep від розміру виводу не залежать.

set -uo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  SELF="${BASH_SOURCE[0]}"
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  pass=0; bad=0
  # check <очікуваний exit> <опис> <очікуваний фрагмент виводу або ""> <команда…>
  check() {
    local want=$1 name=$2 needle=$3; shift 3
    local out got
    out="$("$@" 2>&1)"; got=$?
    if [[ "$got" == "$want" && ( -z "$needle" || "$out" == *"$needle"* ) ]]; then
      pass=$((pass + 1)); echo "ok      очік=$want факт=$got  $name"
    else
      bad=$((bad + 1)); echo "ПОМИЛКА очік=$want факт=$got  $name → ${out%%$'\n'*}"
    fi
  }
  sample() { printf '%b' "$2" > "$T/$1"; }   # sample <ім'я> <текст з \n>
  # Зразки — з реального виводу інструментів проєкту.
  sample vitest-ok ' Test Files  12 passed (12)\n      Tests  340 passed (340)\n   Duration  5.21s\n'
  sample vitest-fail ' FAIL  src/a.spec.ts > x\n Test Files  1 failed | 11 passed (12)\n      Tests  2 failed | 338 passed (340)\n'
  sample vitest-block '⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯\n      Tests  339 passed (339)\n'
  sample vitest-crlf ' Test Files  3 passed (3)\r\n      Tests  12 passed (12)\r\n'
  sample pw-flaky '  3 flaky\n    [chromium] › a.spec.ts:10:3 › x\n  276 passed (4.1m)\n'
  sample pw-failed '  15 failed\n    [chromium] › a.spec.ts:10:3 › x\n  6 flaky\n  276 passed (5.0m)\n'
  sample pw-didnotrun '  1 failed\n  35 did not run\n  200 passed (3.0m)\n'
  sample turbo-ok '@sto/web:type-check: \n@sto/api:type-check: \n\n Tasks:    7 successful, 7 total\nCached:    0 cached, 7 total\n  Time:    41.2s\n'
  sample turbo-partial '@sto/web:lint: error\n Tasks:    6 successful, 7 total\nFailed:    @sto/web#lint\n'
  sample turbo-zero ' Tasks:    0 successful, 0 total\n'
  sample turbo-pw '@sto/web:e2e:   15 failed\n@sto/web:e2e:   276 passed (4.0m)\n\n Tasks:    1 successful, 1 total\n'
  sample turbo-tsc '@sto/web:type-check: src/a.ts(3,7): error TS2322: Type x\n Tasks:    7 successful, 7 total\n'
  sample eslint-warn '/x/a.ts\n  3:1  warning  Unexpected any  @typescript-eslint/no-explicit-any\n\n✖ 3812 problems (0 errors, 3812 warnings)\n'
  sample eslint-err '✖ 5 problems (2 errors, 3 warnings)\n'
  sample dep-ok '\n✔ no dependency violations found (812 modules, 2403 dependencies cruised)\n'
  sample dep-err '  error no-circular: a.ts → b.ts\n\nx 3 dependency violations (3 errors, 0 warnings). 812 modules, 2403 dependencies cruised.\n'
  sample tsc-err 'src/a.ts(1,20): error TS2307: Cannot find module x\n'
  sample unknown 'hello world\n'
  : > "$T/empty"
  # Великий вивід: ~600 КБ попереджень lint — саме на ньому --cmd зависав під pre-push.
  awk 'BEGIN { for (i = 0; i < 6000; i++) printf "/repo/apps/web/src/f%05d.tsx\n  1:1  warning  Unexpected any. Specify a different type  no-explicit-any\n", i;
               print "\n✖ 6000 problems (0 errors, 6000 warnings)" }' > "$T/big"

  check 0 "vitest pass (stdin)"                       "ЧИСТО"     bash "$SELF" vt < "$T/vitest-ok"
  check 1 "vitest: N failed | M passed"              "НЕ ЧИСТО"  bash "$SELF" vt < "$T/vitest-fail"
  check 1 "vitest: блок падінь без підсумку"        "Failed Tests" bash "$SELF" vt < "$T/vitest-block"
  check 0 "vitest CRLF (Windows)"                     "ЧИСТО"     bash "$SELF" vt < "$T/vitest-crlf"
  check 0 "playwright flaky названо"                  "3flaky"    bash "$SELF" pw < "$T/pw-flaky"
  check 1 "playwright 15 failed при exit 0 (--cmd)"   "15failed"  bash "$SELF" --cmd pw -- cat "$T/pw-failed"
  check 1 "playwright did not run"                    "35didnotrun" bash "$SELF" pw < "$T/pw-didnotrun"
  check 0 "turbo 7 successful, 7 total"               "ЧИСТО"     bash "$SELF" --file "$T/turbo-ok" turbo
  check 1 "turbo 6 із 7"                              "6 із 7"    bash "$SELF" --file "$T/turbo-partial" turbo
  check 1 "turbo 0 задач ≠ успіх"                     "НЕ РОЗПІЗНАНО" bash "$SELF" turbo < "$T/turbo-zero"
  check 1 "turbo-префікс не ховає 15 failed"          "15failed"  bash "$SELF" turbo < "$T/turbo-pw"
  check 1 "turbo-префікс не ховає error TS"           "error TS"  bash "$SELF" turbo < "$T/turbo-tsc"
  check 0 "eslint ✖ N problems (0 errors"             "ЧИСТО"     bash "$SELF" lint < "$T/eslint-warn"
  check 1 "eslint з errors"                           "eslint errors" bash "$SELF" lint < "$T/eslint-err"
  check 0 "depcruise без порушень"                    "ЧИСТО"     bash "$SELF" cycles < "$T/dep-ok"
  check 1 "depcruise 3 errors"                        "dependency-cruiser" bash "$SELF" cycles < "$T/dep-err"
  check 0 "tsc: порожній вивід + exit 0 (--cmd)"      "порожній вивід" bash "$SELF" --cmd tsc -- true
  check 1 "--cmd: exit code ≠ 0"                      "exit code 1" bash "$SELF" --cmd tsc -- cat "$T/tsc-err" "$T/no-such-file"
  check 1 "error TS у pipe"                           "error TS"  bash "$SELF" tsc < "$T/tsc-err"
  check 1 "порожній stdin ≠ чисто"                    "НЕ РОЗПІЗНАНО" bash "$SELF" x < "$T/empty"
  check 1 "нерозпізнаний вивід ≠ чисто"               "НЕ РОЗПІЗНАНО" bash "$SELF" x < "$T/unknown"
  t0=$(date +%s%N 2>/dev/null || date +%s)
  check 0 "~600 КБ виводу через --cmd (pre-push)"     "ЧИСТО"     bash "$SELF" --cmd lint -- cat "$T/big"
  t1=$(date +%s%N 2>/dev/null || date +%s)
  if (( ${#t0} > 12 )); then ms=$(( (t1 - t0) / 1000000 )); else ms=$(( (t1 - t0) * 1000 )); fi
  # Зависання — це хвилини; 20 с із запасом покриває повільний CI-раннер.
  if (( ms > 20000 )); then
    bad=$((bad + 1)); echo "ПОМИЛКА великий вивід: $ms мс (> 20000)"
  else
    pass=$((pass + 1)); echo "ok      великий вивід ($(wc -c < "$T/big") байт): $ms мс"
  fi
  total=$((pass + bad))
  echo
  # Підсумок у формі, яку розпізнає сам verdict.sh.
  if (( bad )); then echo "$bad failed | $pass passed ($total)"; exit 1; fi
  echo "$pass passed ($total)"
  exit 0
fi

F="$(mktemp)"; trap 'rm -f "$F" "$F.raw" "$F.tmp"' EXIT

LABEL="${1:-прогін}"
if [[ "${1:-}" == "--cmd" ]]; then
  LABEL="${2:?--cmd потребує мітку}"
  shift 2
  [[ "${1:-}" == "--" ]] && shift
  "$@" > "$F.raw" 2>&1; RC=$?
  tr -d '\r' < "$F.raw" > "$F"
  # Тиша + exit 0 = успіх (саме так поводиться tsc). Текст перевіряємо нижче все одно:
  # інструмент може надрукувати помилки й усе одно вийти з 0 (бувало з Playwright).
  if (( RC != 0 )); then
    echo "❌ НЕ ЧИСТО — $LABEL: exit code $RC"
    grep -q . "$F" && head -5 "$F"
    exit 1
  fi
  if ! grep -q '[^[:space:]]' "$F"; then
    echo "✅ ЧИСТО — $LABEL (порожній вивід + exit 0)"
    exit 0
  fi
elif [[ "${1:-}" == "--file" ]]; then
  SRC_FILE="${2:?--file потребує шлях}"
  LABEL="${3:-$(basename "$SRC_FILE")}"
  tr -d '\r' < "$SRC_FILE" > "$F"
else
  tr -d '\r' > "$F"
fi

# Turborepo дописує до кожного рядка задачі префікс "@sto/web:e2e: ". Патерни нижче
# заякорені на початок рядка (`^  15 failed`), тож під turbo вони мовчали, а підсумок
# "Tasks: N successful, N total" давав «ЧИСТО» поверх `15 failed` (Playwright виходить з 0).
# Префікс знімаємо лише коли підсумок turbo є — звичайний вивід не чіпаємо.
TURBO_SUMMARY="Tasks:[[:space:]]+[0-9]+ successful, [0-9]+ total"
if grep -qE "$TURBO_SUMMARY" "$F"; then
  sed -E 's/^@?[A-Za-z0-9_.\/-]+:[A-Za-z0-9_-]+: ?//' "$F" > "$F.tmp" && mv -f "$F.tmp" "$F"
fi

has() { grep -qE "$1" "$F"; }
fail=0
notes=()

# ── Ознаки падіння. Кожен патерн — із реального виводу інструментів проєкту.
# Vitest/Playwright: "15 failed", "2 failed | 3113 passed"
has "^[[:space:]]*[0-9]+ failed" &&
  { fail=1; notes+=("$(grep -oE "^[[:space:]]*[0-9]+ failed" "$F" | head -2 | tr -d ' ')"); }
has "[0-9]+ failed \|" &&
  { fail=1; notes+=("$(grep -oE "[0-9]+ failed \| [0-9]+ passed" "$F" | head -2)"); }
# Playwright: тести, що не запустились через maxFailures — набір НЕ пройдено
has "^[[:space:]]*[0-9]+ did not run" &&
  { fail=1; notes+=("$(grep -oE "^[[:space:]]*[0-9]+ did not run" "$F" | head -1 | tr -d ' ')"); }
# Vitest: блок "Failed Tests"
has "Failed Tests|⎯ Unhandled Error" && { fail=1; notes+=("блок Failed Tests/Unhandled Error"); }
# tsc
has "error TS[0-9]+" && { fail=1; notes+=("$(grep -cE "error TS[0-9]+" "$F") × error TS"); }
# eslint (саме errors, не warnings)
has "✖ [0-9]+ problems? \([1-9][0-9]* errors?" && { fail=1; notes+=("eslint errors"); }
# dependency-cruiser: «x 3 dependency violations (3 errors, 0 warnings)». Без цієї ознаки
# в об'єднаному виводі (`pnpm cycles; pnpm type-check`) цикл ховався за успіхом turbo.
has "[0-9]+ dependency violations \([1-9][0-9]* errors?" && { fail=1; notes+=("dependency-cruiser errors"); }
# загальні
has "^(FAIL|ERROR)\b" && { fail=1; notes+=("рядок FAIL/ERROR"); }

# ── Ознаки успіху — потрібні, щоб відрізнити «чисто» від «нічого не розпізнано».
ok=0
has "^[[:space:]]*(Tests|Test Files)[[:space:]]+[0-9]+ passed" && ok=1
has "^[[:space:]]*[0-9]+ passed \(" && ok=1
has "✖ [0-9]+ problems? \(0 errors" && ok=1
# dependency-cruiser (pnpm run cycles): «✔ no dependency violations found (N modules, …)».
has "no dependency violations found" && ok=1
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
done < <(grep -oE "$TURBO_SUMMARY" "$F" | grep -oE "[0-9]+ successful, [0-9]+" | tr -d ',a-z')

# flaky не валить вердикт, але МУСИТЬ бути названий — інакше «0 failed»
# звучить як ідеальний результат, хоча частина тестів пройшла лише з retry.
flaky="$(grep -oE "^[[:space:]]*[0-9]+ flaky" "$F" | head -1 | tr -d ' ')"

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
