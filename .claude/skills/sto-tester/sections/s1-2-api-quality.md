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
- [ ] Київські межі доби (`kyivDayStart` / `kyivDayEnd` / `normalizeKyivDateRange` / `kyivDayRangeFilter`) на колонці `@db.Date` → Prisma зводить параметр до дати, «з 20.10» (19.10 21:00 UTC) стає 19.10 — період захоплює попередній день. Для `@db.Date` — `dateOnlyRangeFilter` (конструктор звітів 2026-10-25: звіт за 20.10 давав наряди й рахунки 19.10). Перевірка — живим запитом за день, у якому документів немає: має бути 0. Grep: `grep -rnE "kyivDay(Start|End|RangeFilter)|normalizeKyivDateRange" apps/api/src --include=*.ts | grep -v spec` → для кожного поля звірити тип у `prisma/schema/*.prisma`
- [ ] Запит по РЯДКАХ документа (`workOrderPart`, `purchaseOrderLine`, рядки складського документа) фільтрує лише власний `deletedAt` → бере рядки видалених документів (видалення не каскадить на рядки; GOTCHAS 2026-10-25: 504 із 549 запчастин). Потрібно ще `<документ>: { deletedAt: null }`. Grep: `grep -rnE "(workOrderPart|purchaseOrderLine|stockDocumentLine)\.(findMany|aggregate|groupBy|count)" apps/api/src --include=*.ts | grep -v spec`
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
- [ ] Перевірка дати «календарна YYYY-MM-DD» пропускає роки 0000–0099, а рідне `<input type="date">` шле їх, поки рік набирають по цифрі (`0002-…`, `0020-…`) → 500 (Bug #818). Наживо на кожному списку з датами: `0002-10-09`, `0000-01-01`, `0001-01-01`; у браузері набрати дату з клавіатури й дивитись статуси запитів

- [ ] Виправлення класу «дата у відборі» (Bug #817/#818) зроблено в ЧАСТИНІ місць: після нього пройти наживо ВСІ endpoint-и з датою одним циклом (`0000-01-01`, `0001-01-01`, `2026-02-31`, `9999-12-31`, порожнє, повторений параметр) і шукати 500 — а не лише ті, що в diff-і (Bug #820: п'ять списків, Bug #821: онлайн-запис). Grep залишків: `grep -rn "@IsDateString()" apps/api/src/modules --include=*.dto.ts`; `grep -rnE "DATE_RE|\\d\{4\}-\\d\{2\}-\\d\{2\}" apps/api/src/modules --include=*.controller.ts --include=*.service.ts`

---

- [ ] Кожен endpoint із завантаженням файла отримує наживо: текст із розширенням .xlsx, порожній файл, PNG, xlsx-вміст із розширенням .csv → 400 з поясненням, не 500 (Bug #833, клас #751). `grep -n "xlsx.load(" apps/api/src --include=*.ts -r | grep -v spec` — кожен виклик у try/catch або через `loadXlsxWorkbook`.
- [ ] Тіло запиту без DTO-класу (`@Body() body: { … }`) не валідується: рядок іде у `where: { id }` → помилка Prisma → 500 (Bug #835). `grep -rn "@Body() [a-z]*: {" apps/api/src --include=*.controller.ts`.

- [ ] Друкований документ (pdfmake): суми з літералом валюти («грн», «₴») при документі з `currencyId` → доларовий рахунок «… грн» (Bug #865); кількість/години через `String(n)` → «1.5» (Bug #866); реквізити шапки, склеєні звичайними пробілами, рвуться посеред «Банк: …» (Bug #867). Наживо: PDF документа в USD і з дробовою кількістю — текст через `pdfjs-dist` (`pdftotext` губить кирилицю), вигляд — відмалювати сторінку в canvas і подивитись. Grep: `grep -nE "String\((\w+\.)?(quantity|qty|h)\)|} (грн|₴)" apps/api/src/modules/pdf/*.ts`

- [ ] Сторінка, яку бачать усі ролі (дашборд): запити — і на самій сторінці, і в `PREFETCH_MAP` наведення на пункт меню — гейтяться набором ролей ендпоінта; набір звіряє тест із `@Roles` контролера (Bug #879, клас #729). Наживо: вхід КОЖНОЮ роллю → 403 у мережі. `grep -n "'/dashboard'" apps/web/src/components/TopShell.tsx`
- [ ] PATCH-схема перетворює порожнє на `undefined` («не чіпати»), а web шле `x.trim() || undefined` — необов'язкове поле (назва) неможливо очистити (Bug #891). Порожнє в оновленні → `null`. `grep -rn "\.trim() || undefined" apps/web/src --include=*.tsx` + `blankToUndefined` в `*UpdateSchema`. Те саме без `trim`: `notes: form.notes || undefined` у PATCH форми зміни (Bug #901) — `grep -rnE "(notes|comment|description): form\.\w+ \|\| undefined" apps/web/src`
- [ ] Перевірку провели проти іншого об'єкта, ніж той, що у формі (підйомник НАРЯДУ замість підйомника форми), а 400 каже «за цим …» — для користувача хибно (Bug #909). Шукати виклики перевірок, де аргумент береться з батька, а не з DTO; відповідь має назвати перевірений об'єкт
- [ ] Другий шлях читання тієї самої форми DTO (список з `?include=`, експорт) без збагачення першого (`findOne` розв'язує одиницю рядка → список дає базову) — Bug #939. Наживо: один запис обома шляхами, порівняти поля. `grep -n "toPartDto\|toLineDto" apps/api/src/modules/*/*.service.ts` → кожен виклик іде через той самий збагачувач
- [ ] Внутрішній метод на два входи (каса й `POST /payments/:id/reverse`) з текстами відмов одного входу: гонку двох запитів чує «Операцію вже сторновано» про оплату (Bug #944). Відмову за станом — ключем за входом (`ctx`); наживо — 3 паралельні запити з різними ключами
- [ ] Overflow-гейт (`assertMoneyFits`/`@Max`/Zod-cap) перевіряє МЕНШЕ значення, ніж те, що пишеться в `Decimal(p,s)`-колонку: гейт на net-добутку рядка, а в колонку лягає `priceWithVat = net×(1+ПДВ)` (Bug #969); per-line гейт, а переповнюється АГРЕГАТ `Σ(рядки)` у `recalcTotals`/totals-service — `totalWithVat`/`totalAmount` (Bug #970); поле-ціна БЕЗ стелі взагалі, хоч колонка `Decimal(12,2)` (`good.schema` purchasePrice/salePrice, Bug #971). Наслідок — безіменна 500 `numeric field overflow` замість 400 з назвою поля. Для КОЖНОЇ money-колонки простеж шлях ВІД вводу ДО `prisma.create/update({data})` — перевіреним має бути те, що ЗБЕРІГАЄТЬСЯ. Grep: `grep -rn "assertMoneyFits\|recalcTotals\|_sum: {" apps/api/src/modules --include=*.service.ts` → звір аргумент гейта з полем, що летить у `data`. Тест мутаційний: net/рядок на межі + ПДВ/другий рядок → 400; контроль (без ПДВ / агрегат на межі) → проходить. Де ще: будь-який totals-service, похідні `amountBase`/`totalAmountBase` (курс×сума), знижки/націнки, кредит-нота
- [ ] API приймає ширший формат значення, ніж показує поле UI (день `ДД.ММ.РРРР` проти ISO у виборі дати): збережене значення діє, а поле порожнє — прихований фільтр (Bug #974). Для кожного розширеного парсера на бекенді — звір, що контрол UI показує ВСІ прийняті форми (або нормалізує при завантаженні)
- [ ] Нову перевірку конфігу (білий список, `groupable`) додали в запуск, а збереження (dry-run) йде іншим шляхом — невалідне зберігається і падає на кожному запуску (Bug #975). Знайти всі входи, що приймають той самий конфіг (`create*`/`update*`/`run*`), і звести перевірки в одну функцію; наживо — POST збереження з тим, що відхиляє запуск
- [ ] Користувацький «містить» (`contains` Prisma, `ILIKE`) без екранування `%`, `_`, `\` — «a_h» знаходить «cash», «%» — усе (Bug #976). Prisma ці символи НЕ екранує. `grep -rnE "contains: (dto|q|query|search|value)|ILIKE \$\{" apps/api/src --include=*.ts` → значення через `escapeLike`; наживо — пошук `_` і `%`
- [ ] Шаблон зі `{{змінними}}` створює іншу сутність (задача, сповіщення): ліміт поля перевірено на шаблоні, а пишеться відрендерений текст — довший (Bug #999). Типовий текст із змінною з необов'язкового джерела (`Organisation.phone`) → «тел. » порожнє (Bug #998): рендерити наживо на org без реквізитів, текст брати з job-а черги. `grep -rn "renderAutomationTemplate" apps/api/src --include=*.ts`
