# sto-review — журнал: ts

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../SKILL.md`, Крок 1.

### 2026-05-28 — UTF-8 BOM у .ts після Windows/PowerShell — §1

**Сигнал:** перші 3 байти = `ef bb bf`; diff показує `+﻿import`; неконсистентно (лише частина файлів).
**Фікс:** `tail -c +4 "$f" > tmp && mv tmp "$f"`; перевірити tsc 0 errors.
**Severity:** IMPORTANT — tsc толерує, але ламає JSON/ESM парсери, забруднює diff.

### 2026-05-29 — rgba(var(--X-rgb)) на CSS var якого немає → hardcoded fallback ігнорує тему — §1

**Сигнал:** inline `rgba(var(--color-primary-rgb, 59,130,246), a)` — `--color-primary-rgb` НЕ існує (є лише `--color-primary: hsl(...)` цілісне значення).
**Фікс:** `color-mix(in srgb, var(--color-X) ${round(a*100)}%, transparent)` — тема-aware alpha на реальному токені.
**Severity:** IMPORTANT — німа degradation: фіксований колір, зламаний dark mode/rebrand.

### 2026-05-30 — Hook signature change → broken call-sites мовчки пройшли лінтер — §1

**Сигнал:** новий required parameter у експортованій hook (2-arg → 3-arg); tsc-кеш приховує `Expected N arguments`.
**Grep:** `grep -rn "<hookName>(" apps/web/src/app` — звірити arity кожного виклику.
**Фікс:** оновити всі call-sites в одному коміті (типово передати existing destructured value з scope).
**Severity:** IMPORTANT — runtime undefined → crash; TS ловить, але кеш приховує.

### 2026-05-30 — Constants exported but unused → orphan API surface — §1/§11

**Сигнал:** `export const MAX_QUERY_LIMIT = 1000` але `grep -rn "MAX_QUERY_LIMIT" apps/` → 0 матчів; commit обіцяв застосування.
**Фікс:** застосувати у сирітських findMany (`take: MAX_QUERY_LIMIT`) або `// TODO:` коментар; не лишати голий export.
**Severity:** SUGGESTION — orphan surface, degradation якості API.

### 2026-05-30 — IsUUID('4') у DTO ламає тести з nil-style UUID fixtures — §1/§2.3

**Сигнал:** `@IsUUID('4')` у DTO; контрактні тести використовують hex-only `00000000-0000-0000-0000-000000000099` як placeholder.
**Фікс:** `@IsUUID()` без версії (приймає v1-5), або оновити test fixtures на v4. Для `@Param` — `ParseUUIDPipe` без `version`.
**Severity:** IMPORTANT — контракт змінюється без помітних test failures; кросс-cutting через 22+ DTO.

### 2026-05-31 — `(line as any).X` cast для нового optional поля — §1/§13

**Сигнал:** feat додає optional поле у backend DTO + toResponseDto, але frontend interface без нього → `(line as any).unitShortName`.
**Grep:** `grep -rn "@ApiPropertyOptional() <field>?" apps/api/src` → знайти frontend interface.
**Фікс:** додати поле у frontend interface (SSOT — `hooks/api/use<Module>.ts` або `@sto/shared`); прибрати `as any`.
**Severity:** IMPORTANT — TS contract розірваний; регресує при перейменуванні поля (cast мовчить).

### 2026-05-31 — group-hover:\* без `group` класу на батьку → dead CSS — §1/§8

**Сигнал:** `group-hover:opacity-100` всередині батька без `group` у className → hover-зміна не з'являється.
**Grep:** `grep -rn "group-(hover|focus|active|disabled)" apps/web/src/ --include="*.tsx"` → перевірити наявність `group` на батьку.
**Фікс:** додати `group` на найближчий hover-target батько (той що має `onClick`/`cursor-*`).
**Severity:** SUGGESTION/IMPORTANT — прихована UI-підказка.

### 2026-06-03 — Глобальний `[data-state="open"]` CSS селектор б'є по чужих data-state — §1/§8

**Сигнал:** глобальне `[data-state="open"] { animation }` у globals.css без маркера. Radix (Accordion/Dialog/Dropdown/…) використовує `data-state` як публічний контракт.
**Grep:** `grep -nE "^\[data-state=" apps/web/src/app/globals.css | grep -v "data-animate"` (детектор у §8.5).
**Фікс:** скоп-маркер `[data-animate][data-state="open"]`; direct-child `>` для backdrop.
**Severity:** IMPORTANT — catastrophic regression при додаванні будь-якої headless UI бібліотеки.

### 2026-06-03 — `(entity as any).newField` у toDto() — новий optional пропущено у param type — §1/§13

**Сигнал:** новий optional field доданий у DB + `create()`, але НЕ у типізованому параметрі `toDto` → `(entity as any).documentDate`.
**Grep:** `grep -rn "as any)\.[a-z]" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** додати `newField?: Type | null` у structural param type toDto → замінити cast на `entity.newField`.
**Severity:** IMPORTANT — TS contract порушений; IDE refactor не знаходить usages.

### 2026-06-14 — Boundary-константа змінена, але jsdoc/inline comments посилаються на старе значення — §1/§8

**Сигнал:** fix замінив magic number на const (`19*60` → `WINDOW_END*60`, `WINDOW_END=20`), але 3+ jsdoc/inline коментарі у файлі досі з СТАРИМ значенням. Рекурентно: `fef027b0` (calendar.service), `02e16389` (CalendarSlotModal 3 stale comments).
**Grep:** після `(\d+) * 60 → CONST * 60` fix → `grep -rn "<old_number>\|<old_HHmm>" <file>`; звірити з backend const (`grep -rn "WORK_DAY_END_H" apps/api/src`) — frontend і backend const мають збігатися.
**Фікс:** масово оновити коментарі; замінити сирі числа на ім'я константи.
**Severity:** IMPORTANT — майбутній regression коли розробник "виправить" правильний код за коментом.

### 2026-06-16 — blob-download без `appendChild`/`removeChild` + immediate `URL.revokeObjectURL` — §1/§8

**Сигнал:** `URL.createObjectURL(blob)` → `a.click()` → одразу `revokeObjectURL` без setTimeout і без appendChild/removeChild. Firefox/Safari не диспатчать click на detached anchor; Chromium дропає download. (Bug #77/#341 покрив перші handler-и, третій додано окремо).
**Grep:** `grep -rnE "URL\.revokeObjectURL" apps/web/src/ -B5`; `grep -rnE "document\.createElement\(['\"]a['\"]\)" apps/web/src/ -A8 | grep -v "appendChild\|removeChild"`.
**Фікс:** `document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 100);`. Filename — human-readable (`invoice-${invoiceNumber}.pdf`, не UUID).
**Severity:** CRITICAL/IMPORTANT — тиха відмова download.

### 2026-06-17 — `vatMode: string` у service return → cast `as 'NONE' | ...` у консумерах — §1/§13

**Сигнал:** service повертає `Promise<{ vatMode: string }>` замість Prisma enum (`VatMode`) → кожен консумер робить `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'`.
**Grep:** `grep -rnE "Promise<\{[^}]*: string[;,]" apps/api/src/modules --include="*.service.ts"`; `grep -rnE "as ['\"][A-Z_]+['\"] \| ['\"][A-Z_]+['\"]" apps/api/src`.
**Фікс:** `import { VatMode } from '@prisma/client'` → `Promise<{ vatMode: VatMode }>` → видалити всі `as` касти.
**Severity:** IMPORTANT — DRY-загроза; будь-яка зміна enum ламає тихо.

### 2026-06-17 — Prisma `_sum.X` з ugly `(agg._sum as { X?: unknown })` cast — §1

**Сигнал:** `(agg._sum as { totalVat?: unknown }).totalVat ?? 0`. Prisma вже генерує precise `XSumAggregateOutputType` — direct `agg._sum.totalVat` працює.
**Grep:** `grep -rnE "_sum as \{|_count as \{|_avg as \{|_min as \{|_max as \{" apps/api/src --include="*.ts"`.
**Фікс:** прибрати cast; при потребі `pnpm prisma generate`.
**Severity:** SUGGESTION — TS guard слабшає, cargo cult.

### 2026-09-16 — умовно-обовʼязкове числове поле форми: field-level `z.number()` блокує сабміт за НЕактивні (приховані) поля — §1

**Сигнал:** плоска zod-форма (web-стан на react-hook-form), де набір релевантних числових полів залежить від дискримінатора (`rateType`/`kind`/`mode`), але КОЖНЕ числове поле — `numericString()`/`z.coerce.number()`/`z.number()` (обовʼязкове). Порожнє БУДЬ-ЯКЕ з них (навіть приховане неактивне) → NaN/coerce-fail → hard-fail на рівні поля з НЕ-локалізованим `"Expected number, received nan"`. Латентно, коли модалка сідить дефолти у всі поля; стає живим багом, щойно приховане поле очищується/не сідиться → помилка на невидимому полі → «Зберегти нічого не робить». `z.number()` до того ж ПРОПУСКАЄ NaN у діапазонних порівняннях (`NaN <= 0 === false`) — тож наївний superRefine без `isFinite` мовчки пропустив би й порожнє АКТИВНЕ поле.
**Grep:** `grep -rn "numericString()\|z.coerce.number()\|z.number()" packages/shared/src/schemas/forms apps/web/src --include="*.ts" --include="*.tsx"` → для кожної схеми з дискримінованими полями перевірити: чи required-числове поле стає обовʼязковим лише коли активне за дискримінатором.
**Фікс:** field-level → `number | NaN` (напр. `z.preprocess(emptyToNaN, z.union([z.number(), z.nan()]))`), а обовʼязковість+фінітність АКТИВНОГО поля гейтити у `superRefine` через `!Number.isFinite(v.field)` з локалізованим повідомленням (isFinite ПЕРШИМ, до діапазонних порівнянь). Так неактивні порожні поля не блокують, активне порожнє дає укр-повідомлення.
**Severity:** SUGGESTION (латентний; IMPORTANT якщо приховане поле реально очищується) — не-локалізована помилка на невидимому полі → тихий фейл сабміту. Sample: employeeFormSchema percent/ratePerHour/fixedMonthly/bonusPercent (2f974834).

### 2026-09-17 — FORM-схема з `numericString`/`coerce` відхиляє UA-кому у сирому стані форми — §1/§8.2

**Сигнал:** модалка гейтить submit через `safeParse(getValues())`, числові інпути — вільний рядок (`onChange → f.quantity: e.target.value`), а поле `*FormSchema` = `numericString()` або `z.coerce.number()`. Обидва роблять `Number(v)`; `Number('1,5')=NaN` → легітимний UA-ввід `1,5` падає на `.min()` з хибним повідомленням («Кількість повинна бути більшою за нуль»). Локальні add-гейти (`toNumberOrUndefined` = `.replace(',', '.')`) кому приймають → розсинхрон гейт↔payload: рядок додається, але submit блокується. `parseFloat('1,5')=1` — ще гірше (тихе усічення).
**Grep:** `grep -rn "safeParse(getValues())" apps/web/src` → для кожної модалки; `grep -nE "numericString\(\)|z\.coerce\.number" packages/shared/src/schemas/forms/*.schema.ts` → кожне у `*Form*`-схемі = підозра (endpoint-схема ОК: payload numeric JSON).
**Фікс:** у FORM-схемі числові поля → кома-aware: `moneyString()` (обов'язкове), `optionalMoneyNumber()` (опційне, новий helper у validators.ts), або inline `typeof v==='string'?Number(v.replace(',','.')):v`. Endpoint-схеми лишити `numericString`/`coerce`.
**Severity:** IMPORTANT — fail-closed, блокує легітимний submit для UA-локалі. Sample: work-order.schema FORM quantity/normoHours/price/hours (d8a569aa).

### 2026-10-07 — інструмент-порадник видає помилку збору даних за «нічого робити» — §1 (scripts)

**Патерн:** скрипт, що РАДИТЬ, чого НЕ робити (селектор тестів, гейт, детектор), збирає вхід через
`subprocess`/glob/regex і не відрізняє «вхід порожній» від «вхід не зібрано»: `git diff <невідома
база>` → stderr + порожній stdout → «0 змінених файлів, нічого запускати», `exit 0`. Те саме —
шлях у невпізнаному вигляді (абсолютний, `./x`) і категорія файлів, якої немає у списку префіксів
(каркас `apps/api/src/*.ts`, css, `.env`): тиша читається як «перевірено».
**Детектор:** `grep -n "subprocess.run" scripts/*.py` → кожен виклик без перевірки `returncode`;
`grep -n "startswith(" scripts/affected-tests.py` → для списку префіксів спитати «що з файлом,
який не підпав під жоден?» і прогнати скрипт на 1 реальному файлі кожного типу.
**Fix:** помилка → окремий exit code і текст «НЕ ЗРОБЛЕНО»; непокрите — назвати у виводі
(«ПОЗА СЕЛЕКТОРОМ»); правило «усе поза X» замість переліку тек; тест на кожен випадок.
