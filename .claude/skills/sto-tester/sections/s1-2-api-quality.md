# sto-tester — §1.2 — TypeScript / API якість

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.2-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-2.md`:
>
> ```bash
> awk '/T1.2-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-2.md
> ```

### §1.2 — TypeScript / API якість

```bash
# Dead imports/declarations after page/module split (Bug #204-#205, #726-#727)
# tsconfig зазвичай має noUnusedLocals: false → tsc мовчить про неіснуючий runtime impact,
# але мертві імпорти/типи псують tree-shaking + плутають code review + ламаються коли helper переноситься
# у privately-renamed export. Шукати кожен imported symbol чи реально вживається у файлі-споживачі.
#
# ПЕРВИННИЙ детектор (швидший і повніший за grep нижче): `eslint <changed files>` ловить І мертві
# imports (Bug #726 fmtMoney), І мертві ЛОКАЛЬНІ декларації — interface/type/const (Bug #727 unused
# `interface Paginated`), яких grep-по-import нижче НЕ бачить. Патерн split-файлу (винесення частини
# компонента у новий файл, напр. /inventory-вміст → InventoryTab.tsx) ЗАКОНОМІРНО лишає у старому
# файлі і мертвий import (символ переїхав), і мертвий локальний тип (більше не потрібен). Після
# будь-якого refactor(split)/«винести … у <NewFile>» — обов'язково `eslint` на ОБИДВА файли (донор+новий),
# 0 warnings; будь-який `is defined but never used` у файлі-донорі = dead code внесений сплітом → прибрати.
# Severity LOW (lint-only, runtime не зачеплено), але файл-донор у scope зміни → чистити одразу.
for f in $(git diff HEAD --name-only | grep -E "\.(ts|tsx)$"); do
  [ -f "$f" ] || continue
  # extract imported names from { ... } imports
  for sym in $(grep -oE "^import \{[^}]+\}" "$f" | grep -oE "[A-Za-z_][A-Za-z0-9_]+" | grep -v "^import$\|^from$" | sort -u); do
    # count occurrences excluding import line itself
    count=$(grep -c "\b$sym\b" "$f")
    importLines=$(grep -c "^import.*\b$sym\b" "$f")
    used=$((count - importLines))
    if [ "$used" -le 0 ]; then echo "DEAD IMPORT in $f: $sym"; fi
  done
done

# any без виправданого cast
grep -rn ": any\b\|as any\b" apps/api/src/modules/ --include="*.ts" | grep -v "as unknown as\|spec" | head -10

# Prisma model напряму в response
grep -rn "return.*await.*prisma\|res\.json.*prisma\|return prisma" apps/api/src/modules/ --include="*.controller.ts" | grep -v spec | head -10

# BigInt у response без Number() cast
grep -rn "syncVersion\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "Number(\|toNumber()\|spec\|where\|select\|BigInt" | head -10

# @IsUUID без версії — відхиляє nil-UUID (test-only баг)
grep -rn "@IsUUID()" apps/api/src/modules/ --include="*.dto.ts" | head -5

# ParseUUIDPipe відсутній
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe" | head -10

# Ukrainian error messages
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden|Unauthorized|Failed)" | grep -v spec | head -10

# JSON/Record DTO поля без @IsObject() → знімаються whitelist:true → undefined в сервісі (Bug #182)
# КОЖНЕ поле DTO (включно з non-primitive типами) потребує хоча б одного декоратора
grep -rn "Record<string\|: object\b\|: Json\b" apps/api/src/modules/ --include="*.dto.ts" | grep -v "//\|spec" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  lineno=$(echo "$line" | cut -d: -f2)
  # перевірити чи є будь-який @Is decorator на попередніх 3 рядках
  startline=$((lineno > 3 ? lineno - 3 : 1))
  if ! sed -n "${startline},$((lineno-1))p" "$file" | grep -q "@Is\|@Validate\|@Allow"; then
    echo "MISSING DECORATOR on $file:$lineno"
  fi
done
```

- [ ] Немає `any` (крім `as unknown as T`)
- [ ] `toResponseDto()` — жоден Prisma model не повертається напряму
- [ ] `syncVersion: Number(row.syncVersion)` у всіх DTO (Decimal/BigInt → Number)
- [ ] `@Param(':id')` → `ParseUUIDPipe`
- [ ] date-only `@Query('dateTo')` → `lte` МУСИТЬ бути inclusive-of-day (Bug #678) — `T1.2-001`
- [ ] `a ?? b`, де `a` — момент (`DateTime`), а `b` — `@db.Date` (дата без часу = опівніч UTC), далі сортується чи порівнюється як мітка часу → запис із датою без часу завжди «найраніший за день». Порівнювати календарний день (`kyivYmd`) + явний tie-break (Bug #798). Grep: `grep -rnE "(completedAt|paidAt|signedAt|confirmedAt) \?\? \w+\.(documentDate|date)\b" apps/api/src --include=*.ts`
- [ ] query-string enum-фільтр → `Set(Object.values(Enum)).has()` guard ПЕРЕД `as EnumType` (Bug #679) — `T1.2-002`
- [ ] raw `@Query('page'/'limit')` → `+page`/`Number()` → `Math.max/min`-clamp БЕЗ `Number.isFinite`-guard → NaN у Prisma `skip/take` = HTTP 500 (Bug #764) — `T1.2-003`
- [ ] Per-item isolation loop обгортає ЛИШЕ network-крок, DB-write + cursor-advance поза catch → одне падіння валить решту батчу (Bug #768) — `T1.2-004`
- [ ] `throw new XxxException('...')` — повідомлення українською
- [ ] `@IsUUID()` без версії ('all') відхиляє nil-UUID → у **тестах** для UUID-полів: `11111111-1111-4111-8111-111111111111` (v4 layout)
- [ ] JSON/Record DTO поля без `@IsObject()`/`@ValidateNested()` — whitelist мовчки знімає поле (Bug #182) — `T1.2-005`
- [ ] Multipart `await req.file()` обгорнутий у try/catch (Bug #192) — `T1.2-006`
- [ ] Mass DTO migration completeness — grep variant audit (Bug #215) — `T1.2-007`
- [ ] Mass DTO migration variant validator-family audit (Bugs #257-#265) — `T1.2-008`
- [ ] Optional numeric DTO field з тільки @IsOptional() (Bug #283) — `T1.2-009`
- [ ] Inner DTO class з порожніми полями (Bug #247) — `T1.2-010`
- [ ] class-validator DTO → ZodValidationPipe міграція губить per-field validator (`@IsDateString`/`@IsInt`+`@Min`/`@Max`) → Prisma-типізована колонка недовалідована (Bug #753/#754) — `T1.2-011`
- [ ] Startup env-схема (`ConfigModule.forRoot({validate})`) СТРОГІША за рантайм-споживача АБО object-`superRefine` короткозамикає агрегацію (Bug #757/#758) — `T1.2-012`
- [ ] Frontend спільний `publicFetch` форсить `/api/v1` на VERSION_NEUTRAL публічний роут → routing-404 (Bug #761) — `T1.2-013`
- [ ] Generic tree-walk skip-list за ІМЕНЕМ ключа збігається з іменем реального поля → піддерево не обходиться (Bug #763) — `T1.2-014`
- [ ] i18n-ключ/каталог існує, але не під'єднаний у рендер — dead translation export (Bug #762) — `T1.2-015`
- [ ] Fastify request-parse помилка не мапиться у catch-all filter → 500 замість 4xx (Bug #627) — `T1.2-016`
- [ ] multipart file-too-large → 500 замість 413 (Bug #774, той самий filter-gap що Bug #627, інший код) — `T1.2-017`
- [ ] RHF `useFieldArray` `field.id` (синтетичний) vs data `id` (реальний) → зовнішній `Record<id,x>` state кейситься по одному, читається по іншому → «порожньо» (Bug #765) — `T1.2-018`
- [ ] CurrencySelect/async авто-дефолт поля → `field.onChange` → форма «брудна» на open → dirty-guard блокує закриття незайманої модалки (Bug #766, клас #639/#747) — `T1.2-019`
- [ ] `new Date(Date.UTC(y, m-1, d))` парсер дати БЕЗ round-trip guard тихо «перекочує» неіснуючу дату (31.02→03.03) → зіпсована фінансова дата (Bug #767) — `T1.2-020`
- [ ] NATIVE-FALLBACK гілка того самого date-парсера теж перекочує — guard мусить бути на ВСІХ гілках (Bug #772) — `T1.2-021`
- [ ] Дата у query-DTO під нестрогим `@IsDateString()`: `2026-02-31` проходить і перекочується в 03.03 (відбір за іншим днем, 200), ISO з часом у `dateTo` + дописаний `T23:59:59.999Z` = безіменний 400 від Prisma (Bug #817). Наживо на КОЖНОМУ списку з датами: `2026-02-31`, `abc`, ISO з часом, порожнє. Фікс: `@Matches(/^\d{4}-\d{2}-\d{2}$/)` + `@IsDateString({ strict: true })`. Grep: `grep -rn "@IsDateString()" apps/api/src/modules --include=*.dto.ts`

---
