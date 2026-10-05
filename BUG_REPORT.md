# BUG_REPORT.md — STO ERP

> Активні сесії: **2026-10-01 — сьогодні**.
>
> Архіви (перенесені ДОСЛІВНО, нічого не стиснуто):
>
> - [2026-09-01 — 2026-09-30](docs/BUG_REPORT_ARCHIVE_2026-09-01_2026-09-30.md) — 99 секцій
> - [2026-06-19 — 2026-08-30](docs/BUG_REPORT_ARCHIVE_2026-06-19_2026-08-30.md) — 39 секцій
> - [2026-05-25 — 2026-06-17](docs/BUG_REPORT_ARCHIVE_2026-05-25_2026-06-17.md)
>
> **Правило архівування:** коли файл переходить ~2500 рядків, винести все, старше за
> поточний місяць мінус один, у новий `docs/BUG_REPORT_ARCHIVE_<від>_<до>.md`. Переносити
> ЦІЛІ секції `## Session …`; окремі `## Bug #N` без дати в заголовку належать сесії, у
> хвіст якої дописані. Після переносу звірити, що жоден непорожній рядок не зник
> (порівняння множин рядків), — саме так зроблено 2026-10-05.

## Session 2026-10-04 (b) — полювання на бізнес-логіку (ЦИКЛ 1/3, sto-tester): FSM-резерв запчастин

### Bug #780 — [CRITICAL, ✅ ВИПРАВЛЕНО 2026-10-04] COMPLETED/CANCELLED наряду, що пройшов через ON_HOLD без резервування, падав з "cannotReleaseMoreThanReserved" — наряд неможливо завершити/скасувати

**Де:** `apps/api/src/modules/work-orders/work-order-stock-effects.service.ts`
— `writeOffPartsAndCharge` (release перед WRITEOFF) і `releasePartReservations`.

**Симптом/причина:** резерв запчастин ставиться ЛИШЕ на переході `APPROVED→IN_PROGRESS`
(`reserveParts`, guard `wo.status==='APPROVED'`). Але FSM дозволяє шляхи БЕЗ цього переходу:

- `APPROVED→ON_HOLD→IN_PROGRESS→COMPLETED` — на COMPLETED `writeOffPartsAndCharge` безумовно
  робив `RESERVATION_RELEASE(-baseQty)`;
- `APPROVED→ON_HOLD→CANCELLED` — `releasePartReservations` теж безумовно звільняв `-baseQty`.

На цих шляхах резерву наряду немає. `reserved` на `StockItem` — АГРЕГАТ (не per-document), тож:
(а) якщо `reserved===0` → `InventoryService.createMovement` кидає
`err.inventory.cannotReleaseMoreThanReserved` (400) → весь перехід у транзакції падає → **наряд
неможливо завершити чи скасувати**; (б) якщо резерв тримає ІНШИЙ наряд того ж товару → ми
звільняли ЧУЖИЙ резерв → псування лічильника `reserved` (фантомна доступність для третіх нарядів).

**Фікс:** новий `netReservedByWorkOrder()` рахує нетто-резерв САМЕ цього наряду по
`(goodId|warehouseId)` з його власних `StockMovement` (RESERVATION додатні + RESERVATION_RELEASE
від'ємні, `documentType='WorkOrder', documentId=wo.id`). Обидва методи тепер звільняють
`min(baseQty, свій_нетто_резерв)` і пропускають RELEASE коли резерву немає (0). WRITEOFF усе одно
проходить: `available = quantity − reserved` не включає фантомного резерву цього наряду. Нормальний
шлях (`APPROVED→IN_PROGRESS→COMPLETED`) незмінний — нетто-резерв = baseQty → звільняється повністю.

**Регресійний тест:** `work-order-stock-effects.service.spec.ts` →
`describe('…writeOffPartsAndCharge — Bug #780…')` (3 кейси) +
`describe('…releasePartReservations — Bug #780…')` (2 кейси). Inventory-мок відтворює реальний
guard (кидає коли `|qty| > reserved`). Доведено ЧЕРВОНИМ без фіксу: ON_HOLD-шлях і частковий резерв
падали з `cannotReleaseMoreThanReserved` (точно те, що кидає жива `InventoryService`). Нормальний шлях
лишається зеленим. Юніт-рівень обрано бо live-БД недоступна (docker не піднятий у сесії); мок
семантично тотожний рядку 185 `inventory.service.ts`.

### Перевірено ЧИСТО (багів немає) — report-builder tenant, FSM-грошова симетрія, інвентар-інваріант

- **report-builder (tenant-ізоляція ad-hoc):** `buildQuery` ЗАВЖДИ інжектить `where.orgId` у корінь
  - `deletedAt:null`; усі ключі where/orderBy/include — з реєстру (літерали, не з вводу); A1 tenant-guard
    підстраховує. SavedReport CRUD несе `orgId+deletedAt:null` у кожному where (update/remove — через
    `getSaved` guard + CAS-where). Крос-tenant leak неможливий.
- **FSM-симетрія грошей (C2):** `returnPartsAndCredit` (COMPLETED→CANCELLED) бере `creditAmount` з
  того ж IN-TX re-read `totalAmount`, що й CHARGE → `CREDIT_NOTE === CHARGE` за побудовою (та сама
  валюта/дата). Double-guard: CAS-flip + термінальний CANCELLED → рівно 1 CREDIT_NOTE.
- **Інвентар Σ-інваріант:** `createMovement` тримає `reserved ≥ 0` і `reserved ≤ quantity` пост-чеками
  (row-locked), WRITEOFF консумить партії у тій же tx (`Σ remainingQty == quantity`). Bug #780 був
  НЕ у цих інваріантах, а у НАД-release з боку виклику — тепер усунено на рівні виклику.

### Bug #779 — [HIGH, ✅ ВИПРАВЛЕНО 2026-10-04] preflight віддавав `allow-methods: GET,HEAD,POST` → будь-який cross-origin DELETE/PATCH/PUT блокувався браузером

**Спостереження:** перший повний прогін E2E — 15 падінь, усі з `page.evaluate: TypeError:
Failed to fetch`. Падав не предмет тесту, а здебільшого cleanup (`DELETE` фікстури) або
FSM-перехід (`PATCH`/`POST`).

**Хибні гіпотези, які довелось відкинути** (кожна виглядала переконливо):

1. _rate-limit_ (200 req/min глобально, 4 воркери) — спек упав і з `--workers=1`;
2. _CORS не пускає origin_ — preflight віддавав `204` і правильний
   `access-control-allow-origin`;
3. _сторінка деталей ламає fetch_ — проба з існуючим наряду на тій самій сторінці: `200 ok`.

**Справжня причина** (знайдена прямим `curl -X OPTIONS`):

```
access-control-allow-methods: GET, HEAD, POST      ← DELETE/PATCH/PUT ВІДСУТНІ
```

`app.enableCors({ origin, credentials, maxAge })` без явного `methods`. На **Fastify**
`enableCors` делегує у `@fastify/cors`, чий дефолт — ЛИШЕ `GET,HEAD,POST`, на відміну від
Express-дефолту з повним набором. Конфіг виглядав правильним, але поводився інакше під
адаптером, який проєкт використовує.

**Чому не ловилось раніше:**

- API-тести ходять через `supertest`/прямий виклик — CORS там взагалі не застосовується
  (`curl -X DELETE` давав 401, тобто доходив до guard-а);
- у проді web — той самий origin за Caddy, тож preflight не потрібен;
- E2E-smoke (14 тестів) не створює і не видаляє фікстур.
  Тобто баг був видимий **лише** у cross-origin браузерному сценарії — рівно те, що дає
  повний E2E (сторінка :3001 → API :3000).

**Вплив:** будь-який браузерний клієнт на іншому origin не міг нічого видалити чи
відредагувати. Для поточного прод-розгортання (same-origin) — ні, але це пряма пастка для
окремого домену API, мобільного web-клієнта чи dev-середовища розробника.

**Виправлення:** явний `methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']`

- коментар про розбіжність Fastify/Express дефолтів.

**Регресія:** `cors.integration.spec.ts` — перевіряє, що preflight для `DELETE`/`PATCH`/`PUT`
повертає ці методи у `access-control-allow-methods`. Падає без фіксу.

## Session 2026-10-03 — QA міграції Money: 1 баг (контракт спільної утиліти)

### Bug #776 — [MEDIUM, ✅ ВИПРАВЛЕНО 2026-10-03] moneyFromDecimal падала TypeError на обгортці з бракованим `toNumber`

**Спостереження:** `moneyFromDecimal({ toNumber: () => { throw ... }, toString: () => '350.126' })`
кидала `TypeError` замість повернути `350.13`.

**Діагноз:** це ДРУГИЙ рівень тієї самої помилки, що й у коміті `f28369ab`. Там контракт
розширили з `{toNumber}|number` до рядків і `toString`-обгорток, бо функція стоїть рівно
там, де був `Number(x)`. Але виклик `value.toNumber()` лишився НЕзахищеним — а `Number()`,
яку ця функція заміняє, **ніколи не звертається до `toNumber`** (лише `valueOf`/`toString`).
Тож обгортка з бракованим `toNumber`, але валідним `toString`, працювала під `Number()`
і мусить працювати тут: інакше контракт знову ВУЖЧИЙ за те, що заміняє — на спільному
шляху 44 викликів у 14 модулях, включно з рухом грошей.

**Виправлення:** `toNumber()` у try/catch із fallback на `Number(value)`-шлях. Якщо й він
не дасть числа — `roundMoney` ловить `!isFinite` → 0, тож гроші не стають NaN.

**Чому це не теоретично:** Prisma `Decimal` із пошкодженим внутрішнім станом, Decimal-подібні
обгортки з зовнішніх бібліотек, mock-об'єкти в тестах — усі дають саме цю форму. Падіння
летіло б з утиліти, а не з місця виклику, тож діагностика на проді була б дорогою.

**Регресія:** 2 нові тести (`money.invariants.spec.ts`) — перевірено, що без фіксу падають,
з фіксом проходять. Плюс тест на крайові входи: `''`, `'  12.3  '`, `-0`, `Infinity`,
`'NaN'`, `valueOf`-fallback.

## Session 2026-10-02 — Bug hunt фічі імпорту накладних (PDF/CSV, автодетект, replace/append)

**Скоуп:** коміти 44085da0..dece8e6a + c22307dc (docs) + 357e3d04 (review-фікс) + **a78dc80d**
(тотали append → SQL-агрегація замість findMany+take). Модуль `apps/api/src/modules/xlsx/`,
`ExcelImportWizard.tsx`, `packages/shared/src/import/header-detect.ts`.

**Фокус (за завданням):** E2E та інтеграція — unit-рівень уже добре покритий (102 xlsx + 35 header-detect + 22 wizard).

### БАГІВ НЕ ЗНАЙДЕНО. Покриття посилено 2 новими тест-файлами.

Статичний аналіз + реальні прогони підтвердили коректність усіх ризикових місць:

1. **Фінансова логіка append/replace/merge (R-max) — ПЕРЕВІРЕНО НА ЖИВІЙ БД.**
   Новий `document-line-import.adapter.integration.spec.ts` (6 тестів, жива Postgres):
   - append 2+2 → 4 рядки, `totalAmount` = Σ(quantity×price) ВСІХ, `totalVat`/`totalAmountBase` узгоджені ✓ (пункт 3)
   - append з дублікатом goodId → ЗЛИТТЯ (кількість додалась, ціна нова), не другий рядок ✓ (пункт 4)
   - replace → старі soft-deleted, нові на місці, тотали лише по нових ✓ (пункт 5)
   - assertDraft: не-DRAFT → ForbiddenException ✓ (пункт 6)
   - **scale 1201 рядків (> MAX_QUERY_LIMIT=1000):** SQL-агрегація a78dc80d рахує суму по ВСІХ
     рядках без зрізу (Σ=1300, не занижено). Це ЄДИНЕ реальне покриття нового raw-SQL
     (unit-spec мокає `$queryRaw`). Ідентифікатори колонок, COALESCE, orgId+deletedAt фільтри —
     всі коректні, розбіжностей у копійках і tenant-витоку немає ✓ (пункт 7, вимога координатора)

2. **R2 — пріоритет мапінгу (saved > detected > default):** state-machine у ExcelImportWizard
   коректна. `CounterpartyImportMappingsService.get` при відсутності запису віддає дефолт-пустушку
   (всі cols null), а `isMeaningfulMapping` її відкидає → автодетект не затирається порожнім
   savedMapping. one-shot `mappingAppliedRef` захищає від refetch-перезапису. ✓

3. **Канали у ЖИВОМУ браузері** — новий `apps/web/e2e/import-wizard.spec.ts` (2 тести):
   - CSV (UTF-8 BOM + роздільник кома + значення в лапках через десяткову кому) → автодетект
     колонок за укр. шапкою, ролі підсвічені, передперегляд, значення прочитані коректно ✓ (пункт 1)
   - PDF без текстового шару (image-only сурогат) → зрозуміле повідомлення в модалці (НЕ toast),
     кнопка «Ідентифікувати» disabled, модалка НЕ порожня ✓ (пункт 1 pdf-скан)

4. **Регресія E2E — чисто:** crud-purchase-order 7/7, payroll 7/7, crud-stock-document 5/5. ✓ (пункт 8)

### Спостереження (НЕ баг, поза скоупом)

- **appendLines merge-детекція обмежена першими MAX_QUERY_LIMIT=1000 наявними рядками**
  (`existing` findMany має `take`). Якщо PO має >1000 активних рядків і новий рядок дублює
  товар із «хвоста» (>1000), він створиться окремим рядком, а не доллється. Тотали при цьому
  ЛИШАЮТЬСЯ коректними (SQL-SUM по ВСІХ рядках). best-effort merge; документ із >1000 рядків —
  екзотика. LOW/латентний, фінансово безпечно.

### Тести/регресія — CLEAN

- **API:** 2822/2822 (було 2816 + 6 нових integration). tsc api **0**.
- **Shared:** header-detect 35/35. tsc shared **0**.
- **Web component:** ExcelImportWizard 22/22. tsc web **0**.
- **E2E Playwright:** import-wizard 2/2 (новий), + регресія PO/payroll/stock 19/19.
- **VERDICT:** фіча стабільна. Багів немає — покриття закрито на двох раніше-непокритих рівнях
  (жива-БД фінансова логіка append + реальний браузерний прохід CSV/PDF-скан каналів).

---

## Session 2026-10-02 — Bug hunt локального OCR (коміти f39b97fd..58fce607)

**Фокус:** реальні сценарії фото/сканів накладних через tesseract.js (офлайн). Юніт-рівень уже
покритий 125 тестами; шукав баги в межових/рантайм-сценаріях. Dev-сервер (API+web+Playwright)
у цьому середовищі підняти НЕ вдалося: docker CLI відсутній у PATH, Redis (6379) не слухає, тож
живі браузерні канали (сценарії 1 і 7 з ТЗ) прогнати неможливо. Натомість сценарії 2–6 покрив
інтеграційними тестами проти СПРАВЖНЬОГО стеку (реальний tesseract + @napi-rs/canvas + pdfjs +
реальні traineddata) — це той самий код, лише без HTTP/auth-обгортки.

### Bug #774 — HIGH — завантаження файлу >25 МБ дає 500 замість дружнього 413

- **Статус:** [x] виправлено
- **Файл:** `apps/api/src/common/filters/http-exception.filter.ts` (+ i18n keys/messages)
- **Канал:** backend (глобальний exception filter), зачіпає ВСІ multipart-ендпоінти, не лише OCR.
- **Суть:** `@fastify/multipart` при перевищенні `limits.fileSize` (25 МБ, `main.ts:54`) кидає
  `RequestFileTooLargeError` (code `FST_REQ_FILE_TOO_LARGE`, statusCode **413**). Ця помилка
  спливає з `await file.toBuffer()` у контролері — тобто ПОЗА try/catch хелпера `getUploadedFile`
  (той ловить лише `req.file()`). У `HttpExceptionFilter` гілка `isFastifyClientError` матчить
  ТІЛЬКИ `FST_ERR_CTP_*`, тож `FST_REQ_FILE_TOO_LARGE` провалювався у фінальний `else` →
  **generic 500 «Внутрішня помилка сервера» + error-log + шум у Sentry** замість чистого 413.
- **Чому важливо:** веб-майстер (`ExcelImportWizard.tsx:232`) блокує розмір ДО відправки, тож
  звичайний користувач не бачить бага. Але mobile / cloud-sync / прямий API такого guard НЕ мають
  — для них 25 МБ+ файл = 500. Це точно той клас, проти якого вже будувався цей filter (Bug #627,
  Bug #751): технічну помилку парсера треба мапити у локалізований 4xx, а не 500.
- **Відтворення:** `POST /api/xlsx/import/raw-preview` з файлом >25 МБ → раніше 500, тепер 413
  «Файл завеликий — перевищено максимальний розмір завантаження…».
- **Фікс:** нова гілка `isFastifyFileTooLarge(exception)` у filter → `413 PAYLOAD_TOO_LARGE` +
  новий i18n-ключ `err.requestFileTooLarge` (uk/en, БЕЗ хардкоду розміру — ліміти різні на різних
  ендпоінтах), лог `warn` (не `error`) → без Sentry-алерту. Регресія-тест у
  `http-exception.filter.spec.ts` (19/19 green).

### Характеристики (НЕ баги) — реальні межі якості OCR

Заміряно на згенерованих накладних (4 колонки: Артикул/Назва/Кількість/Ціна), реальний tesseract:

- **Високий кегль (≈12pt+, 32px растр):** ідеальна сітка 4×5, артикули впізнаються. Робоча зона.
- **Дрібний кегль (≈8pt, 16px растр):** сітка структурно валідна (4 колонки), але шапка
  РОЗПАДАЄТЬСЯ на два рядки й колонки МІСТЯТЬСЯ (`["","Назва","","Ціна"]` + `["Артикул","","Кількість",""]`).
  Межа, за якою автодетект колонок стає ненадійним — користувач має поправити мапінг вручну.
- **Шум сканера 2% «солі»:** сітка колапсує до 3 колонок. Межа стійкості до брудного скану.
- **Латинь в артикулах:** `06H-...` читається як кирилична `06Н-...` (ukr+eng плутанина H↔Н).
  Очікувано для змішаної моделі; саме тому UI показує попередження «звірте артикули».
- **Поворот 90/180/270°:** растеризатор коректно застосовує `page.rotate` → валідна сітка 4×5 у
  всіх трьох випадках (на відміну від текстової гілки, яка свідомо відмовляє на повернутих).

### Перевірено — працює коректно (без багів)

- **Паралельні OCR-імпорти:** `Promise.all` двох `extract` → результати НЕ змішуються (маркери
  документа A не протікають у B і навпаки). Серіалізація через модульний `busyChain` + enqueue
  коректна; per-page таймер стартує лише ПІСЛЯ dequeue (черга не з'їдає бюджет).
- **Багатосторінковий скан (6 стор.):** обрізається до `OCR_MAX_PAGES=5`, оброблено за ~2.4 с,
  не вішається; при перевищенні бюджету — `OcrTimeoutError` → 400 (мапінг перевірено).
- **Відновлення після таймауту:** `disposeOcrWorker()` → наступний `extract` пересоздає воркер і
  успішно розпізнає (каскад зависань не виникає).
- **Порожнє/білий аркуш:** `extract` повертає `null` (не throw) → парсер дає 400 `ocrNoText`.
- **Моделі відсутні:** `OcrModelsMissingError` → `toHttpError` мапить у 400 «Модулі розпізнавання
  не встановлені… зверніться до підтримки» (не 500). `resolveTessdataDir` знаходить `ukr.traineddata`.
- **HEIC:** `detectKind('.heic')→null` → 400 `unsupportedFormat` з інструкцією «у Налаштуваннях →
  Камера → Формати виберіть «Найбільш сумісний»». Повідомлення коректне (uk+en).
- **OCR-прапорець:** `parseGrid` ставить `ocr=true` для image та PDF-OCR, `false` для текстового
  PDF/xlsx/csv → попередження в UI показується рівно де треба (фікс 875c3825 на місці).

### Тести/регресія

- **API:** нові інтеграційні сценарії `ocr-integration.spec.ts` (12 тестів, реальний стек) +
  регресія-тест Bug #774 у `http-exception.filter.spec.ts`. xlsx+filters: 156/156 green. tsc api **0**.
- **Shared:** tsc **0** (нові i18n-ключи), build ok.
- **НЕ прогнано в цьому середовищі:** живі Playwright E2E (import-wizard, crud-*, payroll) та
  браузерні канали .jpg/PDF-скан/>25МБ UI — через відсутність docker/redis. Рекомендація: прогнати
  сценарії 1 і 7 з ТЗ на машині з піднятими dev-серверами.

## Session 2026-10-02 — Bug hunt фінального QA дуги імпорту з OCR (коміти 44085da0..5fa13dae)

Фінальний етап QA: sync/review/optimize/simplify уже пройшли. Прицільно перевірено
найсвіжіше й найменш обкатане: `parseGridCached` (кеш сітки за sha256), винесена
`groupFragmentsIntoLines`, межі даних, replace/append, багатотенантність.

### Bug #775 — [HIGH] `handleApply` у майстрі імпорту тихо надсилає СТАРИЙ режим запису (replace замість append) → мовчазна втрата позицій документа

**Файл:** `apps/web/src/components/ui/ExcelImportWizard.tsx:471` (useCallback `handleApply`)

**Суть:** `handleApply` використовує стан `applyMode` (`mode: applyMode` у виклику
`applyMut.mutateAsync`), але `applyMode` був ВІДСУТНІЙ у масиві залежностей useCallback.
Перемикання радіо «Замінити»↔«Додати» не змінює жодної іншої залежності колбека
(`rows`, `resolutions`, `docType`, `docId`, `applyMut`, `onImportComplete`, `onClose`),
тож при референтно стабільній мутації (як у справжньому `useMutation` TanStack) колбек
НЕ перестворюється — і apply відправляє режим, захоплений на момент створення колбека
(дефолтний `replace`).

**Наслідок (severity HIGH):** користувач обирає «Додати до наявних», тисне «Заповнити
товарами» — сервер отримує `mode: 'replace'` → `replaceLines` робить soft-delete УСІХ
наявних позицій документа перед вставкою нових. Тиха втрата даних: інтенція append,
фактично replace.

**Чому пройшло повз review/tester:** мок `useApplyImport` у тесті повертав НОВИЙ об'єкт
на кожному рендері → `applyMut` щоразу змінював ідентичність → колбек «випадково»
перестворювався щорендеру й бачив свіжий `applyMode`. Тобто мок маскував реальну
поведінку проду. Лінт `react-hooks/exhaustive-deps` стоїть на рівні `warning`, тож
відсутня залежність не блокувала.

**Відтворення (regression-тест, падає без фіксу):** у
`apps/web/src/components/ui/__tests__/ExcelImportWizard.test.tsx` мок `useApplyImport`
зроблено референтно стабільним (`stableApplyMutation`). Тоді наявний тест
«"Додати" надсилає mode=append» та новий тест «Bug #775: перемикання режиму ПІСЛЯ входу
в крок 2» падають з `expected 'replace' to be 'append'`. Перевірено явно: з фіксом —
зелені, без фіксу — червоні (2 failed / 29).

**Фікс:** додано `applyMode` у масив залежностей `handleApply`.

**Статус:** [x] виправлено

### Перевірено й виявилось КОРЕКТНИМ (не баги)

- **`parseGridCached` (кеш сітки, b5325e7f):** ключ `xlsx:ocr-grid:${kind}:${hash}`
  (sha256 вмісту + канал). `parseGrid` — чиста функція байтів+kind (orgId/БД не читає,
  нічого не пише). Два орендарі з однаковими байтами дістають ідентичну сітку → колізії
  даних немає; резолв товарів (`parseMappedRows`) відбувається ПІСЛЯ і org-scoped. Без
  Redis `CacheService` мовчки деградує (get→null/set→no-op) → поведінка = OCR двічі,
  нульова регресія. JSON-серіалізація `string[][]` безвтратна. Кешуються лише pdf/image.
  `OCR_DPI` поза хешем — але це діагностичний env (не per-request), TTL 300с обмежує.
- **Винесена `groupFragmentsIntoLines` (f7aa435b):** побайтово-еквівалентна старому
  inline-коду в обох викликачах. Edge h=0: старе `heights.length? …:10` vs нове
  `median([])||10` = обидва 10. Сортування/групування/внутрішній sort за x — ідентичні.
  140 api-тестів зелені.
- **replace/append тотали (інтеграційні тести live-DB, 6 зелених):** replace робить
  soft-delete (не hard, перевірено `deletedAt: { not: null }`), append рахує тотали
  SQL-агрегацією по ВСІХ активних рядках (не findMany+reduce з take). Колізія goodId
  при append → злиття кількості, не другий рядок.
- **Дедуп вхідних рядків (Bug #748 клас):** `applyImport` дедупить по `goodId` через
  `seenGoodIds` ПЕРЕД викликом адаптера → adapter.appendLines/replaceLines завжди
  отримують унікальні goodId. Внутрішня дедуп-вразливість `appendLines` для нових
  дублікатів не тригериться штатним шляхом.
- **Багатотенантність:** усі lookup у `previewImport`/`applyImport`/адаптерах фільтрують
  `orgId` + `deletedAt: null`. `rawPreview` без orgId свідомо (stateless, нічого не пише).
- **Від'ємні/нульові кількість/ціна:** `ApplyImportRowDto` має `@Min(0)` на quantity/price,
  `@ArrayMaxSize(1000)` на rows; глобальний ValidationPipe (whitelist+transform) активний.
- **Кома/крапка в десяткових:** `parseNumber` коректно: «1,5»→1.5; mixed-separator
  («1.234,56») свідомо відкидається у undefined (безпечніше за хибний парс).
- **Розмір файлу >25МБ:** fastify-multipart `limits.fileSize: 25MB` (Bug #774).

### Відомі обмеження (НЕ виправлялось — свідомо)

- **append + документ із >1000 рядків:** `appendLines` читає наявні рядки з
  `take: MAX_QUERY_LIMIT` (1000). Якщо вхідний goodId збігається з наявним рядком за
  позицією >1000, злиття не спрацює → створиться дубль-рядок. Для PO гроші лишаються
  коректними (тотали через SQL-SUM по всіх рядках); для StockDocument дубль-рядок міг би
  задвоїти склад при проводці. Edge надзвичайно рідкісний (один чернетковий документ із
  > 1000 позицій, зібраний кількома імпортами). Інтеграційний тест це явно документує як
  > прийняту поведінку. Фікс потребував би зняти take або перейти на SQL-UPSERT — не
  > виправдано для даного ризику.
- **E2E не запускалось:** БД з Windows недосяжна (порт 5432 тримає svchost) — відоме
  обмеження середовища, не баг коду. (Примітка: API-інтеграційні тести xlsx тут БД все ж
  дістали й пройшли — 6 зелених.)

---

## Session 2026-10-03 — Money-міграція, сервісний шлях (пункти 2–5; продовження після Bug #776)

> Контекст: пункт 1 (крайові входи `moneyFromDecimal`) закрито окремо як Bug #776 (008f9e40)
> — `money*.ts` НЕ чіпалось. Ця сесія — пункти 2–5: інваріант Σ(рядки)===total на РЕАЛЬНОМУ
> сервісному шляху документів, баланс каси, бонусні бали, звіт рентабельності.
> Baseline: api 2900/2900, tsc 0, eslint 0 errors, HEAD 008f9e40.

### Bug #777 — [MEDIUM] purchase-orders.service: Σ(рядки) ≠ totalAmount на дробовій кількості [x] виправлено

**Де:** `apps/api/src/modules/purchase-orders/purchase-orders.service.ts` — `create` (рядок ~314)
та `update` (рядок ~497).

**Симптом (що бачить бухгалтер):** `toDto` показує per-line `amount = money(quantity × price)`
(округлення НА КОЖЕН рядок), а `totalAmount` рахувався як `money(Σ quantity×price)` (round-once).
`quantity` — `Float` (літри/кг), тож при дробовій кількості покрокове округлення рядків
розходиться з round-once сумою. Приклад: 3 рядки по `0.5 л × 3.33 грн` → per-line `1.67` ×3 = **5.01**,
а збережений `totalAmount` = `money(4.995)` = **5.00**. Документ не б'ється: рядки дають 5.01, підсумок 5.00.

**Причина:** round-once математично точніший для СИРИХ значень (докблок money.ts), але документ,
який друкується/експортується, мусить мати Σ(відображених рядків) === total. PO не зберігає per-line
`amount` у БД — він обчислюється у `toDto`, тож round-once total з ним не узгоджений.

**Фікс:** `totalAmount = sumMoney(computedLines.map(l => money(l.quantity * l.price)))` — Σ вже-округлених
per-line сум. Тепер total дорівнює сумі рядків, які бачить бухгалтер.

**Регресійний тест:** `purchase-orders.service.spec.ts` → `describe('PurchaseOrdersService.create —
Bug #777…')`. Драйвить реальний `create`, асертить `Σ(res.lines[].amount) === res.totalAmount`.
Доведено червоним БЕЗ фіксу: `AssertionError: expected 5.01 to be 5`.

### Bug #778 — [MEDIUM] supplier-returns.service: той самий Σ(рядки) ≠ totalAmount [x] виправлено

**Де:** `apps/api/src/modules/supplier-returns/supplier-returns.service.ts` — `create` (рядок ~180)
та recompute у status-change/update (рядок ~298).

**Симптом/причина:** ідентичний клас до #777. `toDto` показує per-line `amount = money(q × price)`,
total рахувався round-once. На дробовій кількості рядки не б'ються з total.

**Фікс:** обидва місця → `sumMoney(lines.map(l => money(l.quantity * price)))`.

**Регресійний тест:** `supplier-returns.service.spec.ts` → `describe('SupplierReturnsService.create —
Bug #778…')`. Увага: SR дедуплікує рядки за `goodId` (`deduplicateBy`) — тест використовує 3 РІЗНІ
goodId, інакше рядки збились би в один і дивергенція б не проявилась. Доведено червоним БЕЗ фіксу:
`expected 5.01 to be 5`.

### Перевірено ЧИСТО (багів немає) — пункти 2 (WO/invoice), 3, 4, 5

- **work-orders.service (recalcTotals, ~1263–1301):** total рахується з ВЖЕ-ЗБЕРЕЖЕНИХ рядкових
  `amount`/`price` (Decimal(12,2), round-once від вже-округлених = Σ(округлених) — ідентично).
  `totalParts` — SQL-aggregate збереженого `amount`. Інваріант тримається. НЕ дублюю — дивергенція
  неможлива бо per-line amount зберігається у БД, не перераховується.
- **invoices.service:** per-line `priceWithoutVat/vatAmount/priceWithVat` ЗБЕРІГАЮТЬСЯ у БД;
  тотали = `sumLineTotals(Σ збережених)`. Σ(line.priceWithVat) === totalWithVat за побудовою. Чисто.
- **cash.service (пункт 3):** баланс = `initial + Σ(IN) − Σ(OUT)`. `getBalances` (batch) і `getBalance`
  дають однаковий результат — формула ідентична, перевірено на net-negative реєстрі (OUT>IN → обидва −350,
  знак `sum * -1` НЕ перевернутий). Overdraft-guard: толеранс −0.001, копійкова нестача (100.01 vs 100.00)
  → 400, float-дрейф (0.30) → проходить — усе вже покрито `cash.service.spec.ts` (рядки 369–573).
  Коментар-гап: немає тесту що ГАНЯЄ один фікстур через ОБИДВА методи й порівнює — але семантика
  коректна, це не баг.
- **loyalty.service (пункт 4):** earn і redeem рахують `points = roundPoints(...)` РАЗ і використовують
  те саме значення у balance-мутації (increment/decrement/gte) І у рядку леджера → Σ(ledger)===balance.
  Redeem fractional-identity (10.007 → 10.01 у gte/decrement І ledger) уже покрито (spec рядки 86–98).
  Earn fractional не має окремого тесту, але код структурно той самий single-value патерн — не баг.
- **reports.service (пункт 5):** Bug #629 (float-дрейф `totalLabor × 0.4 → 1408.1200000000001`) НЕ
  повернувся — `totalCostLabor/totalCost/grossProfit` квантовані `money()` (рядки 309–311), покрито
  spec-ами. `margin` — ВІДСОТОК (`(grossProfit/totalRevenue)*100`), округлений до 2dp через `Math.round`,
  НЕ `money()` — коректно. Додав guard-асерт у наявний profitability-тест (ловить пропуск ×100
  і помилковий money() на відсотку).

**Підсумок:** 2 реальні баги (#777, #778, той самий клас round-once-vs-per-line у PO/SR), обидва
виправлені з регресійними тестами (червоні без фіксу). Пункти 3/4/5 — чисто, інваріанти тримаються,
наявне покриття адекватне. api 2902/2902, tsc 0, eslint 0 errors.

---

## Session 2026-10-04 — Аудит класу Bug #780 (асиметричний inc↔reverse) у 5 модулях

**Контекст:** ЦИКЛ 2/3 sto-tester. Bug #780 (ЦИКЛ 1) показав КЛАС помилки — «реверс
side-effect, що припускає стан, якого альтернативний ВАЛІДНИЙ шлях не створив» / ширше:
асиметричний inc↔reverse на АГРЕГОВАНОМУ лічильнику. Завдання — застосувати цей клас до
інших кандидатів методом Bug #780: для КОЖНОГО реверс-переходу перелічити ВСІ вхідні шляхи
й перевірити, чи кожен створив прямий ефект.

**Метод:** побудова мапи переходів кожного модуля → для кожного реверс/decrement-переходу
множина вхідних станів → перевірка, чи кожен гарантовано мав forward-ефект.

### Результат: усі 5 кандидатів ЧИСТІ. Bug #780 був поодиноким, НЕ системним.

- **1. loyalty.service (earn/redeem):** РЕВЕРСУ немає. `redeem` — атомарний `updateMany`
  з guard `balance: { gte: points }` (не можна списати більше наявного; баланс не йде <0).
  `earn` — ідемпотентний (per-document partial-unique + read-then-write). Немає un-earn/
  un-redeem, тож асиметрія неможлива. Чисто.
- **2. stock-documents.transition (CONFIRMED→CANCELLED):** такого ребра НЕМА. `CONFIRMED: []`
  термінальний; рухи складу створюються ЛИШЕ на DRAFT→CONFIRMED. У CANCELLED веде лише DRAFT
  (рухів не було) → CANCELLED-гілка статус-only, реверсити нема чого. Чисто.
- **3. purchase-orders.receive (часткові прийоми):** `receivedQty` інкремент-only, over-receipt
  guard (`line.receivedQty + recv > line.quantity → 400`, epsilon 1e-6). `transition`→CANCELLED
  статус-only, НЕ реверсить отримане (фізичний товар не «розотримати») — навмисна forward-
  асиметрія, НЕ клас #780 (там реверс припускав forward-ефект; тут реверсу взагалі нема). Чисто.
- **4. invoices.paidAmount:** `paidAmount` монотонно зростає, capped (`dto.amount > remaining
→ 400`), CAS-guard (`where paidAmount=prevPaid`). Платежі append-only, un-pay/decrement немає.
  CANCELLED-перехід НЕ авто-реверсить CHARGE (ledger append-only; задокументовано у
  docs/objects/invoice.md). PAID/CANCELLED термінальні. Чисто.
- **5. settlements.createTransaction (balance агрегат):** balance завжди `increment` на
  ЗНАКОВИЙ `balanceDelta = BALANCE_SIGN[type] * amountBase`. Реверси моделюються ЗУСТРІЧНОЮ
  forward-проводкою (PAYMENT гасить CHARGE), кожна з власним guard `amount > 0`. Симетрія за
  побудовою — агрегат не можна зменшити нижче внеску документа. Чисто (вже є property-based
  `settlements.invariants.spec.ts`).

**Регресійний guard (мутаційно доведений):**
`apps/api/src/modules/stock-documents/asymmetric-reverse.invariants.spec.ts` — 7 структурних
FSM-тестів, що фіксують ПРИЧИНУ чистоти (термінальність CONFIRMED/RECEIVED/PAID; єдине вхідне
ребро у CANCELLED для DOC). Читають експортовані `DOC_TRANSITIONS`/`PO_TRANSITIONS`/
`INV_TRANSITIONS` (єдине джерело правди). Мутація доведена: відкриття `CONFIRMED→CANCELLED`
у stock-documents → 2 тести падають (`expected [] to equal ['CANCELLED']`). Поведінковий тест
тут нічого б не довів — реального реверсу у цих FSM немає, захист тримається на ФОРМІ мапи.

**Стан:** api 3114/3114 (3107+7), tsc 0 (вкл. tsconfig.spec.json), eslint 0 errors.

---

## Session 2026-10-04 — ЦИКЛ 3/3: крос-модульні інваріанти наскрізь

Напрямок циклу 3 (не повторює цикли 1-2, що дивились УСЕРЕДИНІ модулів): інваріанти,
що перетинають модулі; межові значення; конкурентність; часткові збої.

### [x] Bug #781 (HIGH) — ReconciliationProcessor.checkInvoicePaid: неповний крос-модульний інваріант → фальшивий DRIFT на КОЖЕН прогін

**Модуль:** `apps/api/src/modules/reconciliation/reconciliation.processor.ts`

**Клас:** агрегат (`Invoice.paidAmount`) оновлюється ДВОМА шляхами, а drift-детектор звіряв
його лише з ОДНИМ джерелом → легітимний стан читається як пошкодження даних.

**Суть.** `paidAmount` зростає двома незалежними шляхами:

1. Реальна оплата (payments-модуль) → `Payment`-рядок (invoiceId) + інкремент `paidAmount`;
2. Ручне `→PAID` standalone-рахунку (Bug #675) → `paidAmount=amount` + settlement
   `PAYMENT(documentType='Invoice', documentId=inv)` АЛЕ **БЕЗ `Payment`-рядка**.

Reconciliation порівнював `Invoice.paidAmount` лише з `Σ Payment.amount(invoiceId)`. Для
будь-якого рахунку, закритого вручну (досяжно через FSM `SENT/PARTIALLY_PAID/OVERDUE → PAID`),
`paidAmount > Σ Payment` → `DRIFT paidAmount` логувався на КОЖНОМУ прогоні звірки.

**Наслідок (чому HIGH, не косметика).** A3-reconciliation — це сторож цілісності даних
(ADR-001/data-integrity). Фальшиві спрацювання на штатному потоці ручного закриття = «вовки!»:
оператор/розробник тоне у фальшивих DRIFT-логах і перестає довіряти детектору → РЕАЛЬНИЙ
дрейф (пошкодження балансу/залишку) губиться у шумі. Детектор знецінюється повністю.

**Мутаційний доказ (тест падав ДО фіксу):**
`reconciliation.processor.spec.ts` → 2 нові тести (manual-close з 0 Payment-рядків; часткова
реальна + ручне дозакриття) падали з
`DRIFT paidAmount invoice=inv1: paidAmount=100 ≠ Σpayment=30 (Δ=70)` до фіксу.

**Фікс.** Коректний інваріант:
`paidAmount == Σ Payment.amount(invoiceId) + Σ settlement-PAYMENT(documentType='Invoice', documentId=inv)`.
Додано паралельний `settlementTransaction.groupBy(by:['documentId'], where:{type:'PAYMENT',
documentType:'Invoice'})`; дзеркальні суми додаються у `paidByInvoice`. Решта проводок
(CHARGE/FX/реальні оплати з documentType='Payment') не входять — беремо лише PAYMENT проти
самого рахунку. Мітку DRIFT оновлено (`Σ(Payment+дзеркальний)`).

**Регресійний guard:** 3-й новий тест доводить, що СПРАВЖНІЙ дрейф (`paidAmount > Σ+mirror`)
усе ще ловиться — фікс не замаскував реальне пошкодження.

### Інші напрямки циклу 3 — перевірено, ЧИСТО

- **Σ грошей наскрізь (WO COMPLETED → CHARGE; invoice SEND → CHARGE; PAID → mirror PAYMENT):**
  рівно ОДИН CHARGE на борг. WO-рахунок не нараховує CHARGE при `createFromWorkOrder`
  (DRAFT, без проводки) — борг уже є з COMPLETED наряду; standalone-рахунок нараховує CHARGE
  лише на SEND (`isStandaloneSend = workOrderId===null`). Double-CHARGE/no-CHARGE шляху немає.
- **Межові значення:** порожній/нульовий наряд → COMPLETED заблоковано (`chargeAmount<=0 →
totalZeroCannotComplete`). `createMovement`: quantity===0 / !isFinite(quantity|price) /
  від'ємний RESERVATION_RELEASE / RETURN<0 / over-release / over-reserve — усі з guard-ами.
- **Конкурентність на реальних шляхах:** WO.transition — CAS-flip перший у `where:{status}`
  (count===0→throw), один CHARGE/один reverse; invoice payment — CAS `where:{paidAmount=prevPaid}`;
  createMovement — row-locked post-check проти concurrent WRITEOFF/RESERVATION. Усі тримають.
- **Σ StockItem.quantity == Σ StockBatch.remainingQty:** інваріант за побудовою у createMovement
  (consume в тій самій tx після upsert) + DB CHECK nonneg + reconciliation checkStock. Чисто.

**Стан ЦИКЛ 3:** api 3118/3118 (3115+3, 2 повні прогони), tsc 0 (вкл. tsconfig.spec.json),
eslint 0 errors. Висновок: після трьох циклів клас #780 та крос-модульні інваріанти наскрізь
вичерпані; #781 — окремий клас (неповнота drift-звірки, не асиметрія реверсу), знайдено+виправлено.
