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

---

## Session 2026-10-07 — Bug hunt `206df580..HEAD` (календарі DatePicker/DateTimePicker, field-encryption.integration, verdict.sh)

Обсяг — лише зачеплені діапазоном файли. Три підозри від review перевірено запуском; дві
з трьох виявились не багами (Enter у `<form>`, зайві дії Escape поза модалкою), одна — багом
(#782). Ще два (#783, #784) знайдено пробою в браузері всередині `InvoiceCreateModal`.

## Bug #782 — [HIGH] Інтеграційний тест hard-delete-ить СПРАВЖНІ конфіги каналів розробника

**Файл:** `apps/api/src/prisma/field-encryption.integration.spec.ts:139` (`cleanup()`, стан до фіксу)
**Severity:** HIGH
**Категорія:** test-coverage (ізоляція тестових даних, втрата даних у dev-БД)

**Опис:** `TEST_CHANNEL = 'SMS'`, `LEGACY_CHANNEL = 'EMAIL'` — це значення справжнього enum
`NotificationChannel`, а не тестові маркери. `cleanup()` виконував
`DELETE FROM notification_channel_configs WHERE "branchId" = <garageBranch.findFirst()> AND channel IN ('SMS','EMAIL')`
— без жодної ознаки «рядок створив тест». `@@unique([branchId, channel])` означає, що на філії
може бути рівно один SMS-рядок, і якщо розробник налаштував SMS/EMAIL-канал, це саме його рядок.
Дефект передіснуючий (cleanup був у `beforeAll`/`afterAll`); коміт `a2a16110` додав виклик ще й у
`beforeEach`, тобто перед кожним із 6 тестів.

**Доказ (запуск):** у dev-БД вставлено пробний рядок `channel='SMS', provider='tester-probe-real-cfg'`
на першу філію → `npx vitest run src/prisma/field-encryption.integration.spec.ts` → 6 passed →
рядка в таблиці немає. Набір зелений, конфіг стерто, ключ провайдера втрачено безповоротно
(hard delete, у моделі є `deletedAt`, але його оминули raw SQL-ем).

**Очікувана поведінка:** тест не змінює і не видаляє рядки, яких сам не створив.
**Фактична поведінка:** кожен зелений прогін стирав SMS- і EMAIL-конфіги першої філії.

**Фікс:** кожен тест виконується в інтерактивній транзакції, що завжди відкочується
(`inRolledBackTx`): звільнення слотів `@@unique`, вставка тестових рядків і всі перевірки живуть
усередині неї; raw-запити йдуть через той самий tx-клієнт. У БД нічого не комітиться — навіть
якщо процес убито посеред тесту. `cleanup()`/`beforeEach`/hard-delete прибрано. Імена кейсів не
змінились (baseline без diff).

**Перевірка фіксу:** той самий пробний рядок пережив звичайний прогін і прогін із
`--sequence.shuffle`. Мутація (`toBe(PLAINTEXT_KEY)` → `toBe('MUTANT')`) валить (b) і (d) — тести
не стали вічнозеленими через обгортку.

**Статус:** [x] виправлено

## Bug #783 — [MEDIUM] Escape закриває всю модалку, якщо календар DatePickerInput відкрито кнопкою-іконкою

**Файл:** `apps/web/src/components/ui/date-picker-input.tsx:153` (стан до фіксу)
**Severity:** MEDIUM
**Категорія:** frontend

**Опис:** коміт `918f21d9` додав `onKeyDown` з `stopPropagation()` лише на `<input>`. Але календар
відкривається ще й кнопкою-іконкою (фокус лишається на ній), а всередині попапа фокус може бути
на кнопках днів, навігації місяців і «Сьогодні». У всіх цих випадках обробник не спрацьовує, і
Escape доходить до `<Modal>` (слухач на `document`). Review перевірив у браузері лише випадок
«фокус у полі» і записав у CHANGELOG «у `date-picker-input.tsx` дефекту немає».

**Доказ (браузер, логін через UI, `/invoices` → «Рахунок»):** клік по іконці календаря →
`{cal:1, dialogs:1, active:BUTTON}` → Escape → `{cal:0, dialogs:0}` — модалка закрита разом із
формою. Для шляху «фокус у полі» це не регресія відносно `206df580` (там Escape закривав модалку
завжди), але заявлений фікс покривав один шлях із кількох.

**Очікувана поведінка:** Escape з відкритим календарем закриває лише календар, де б не був фокус.
**Фактична поведінка:** при фокусі поза полем закривалась модалка-батько.

**Фікс:** Escape перехоплюється на `document` у capture-фазі зі `stopImmediatePropagation()`,
доки календар відкритий — так само, як у `DateTimePickerInput` після `21ec0513`. Enter лишився на
полі (на кнопці Enter — це клік). Після фіксу в тій самій пробі: `{cal:0, dialogs:1}`, другий
Escape закриває модалку.

**Тест:** `DatePickerInput.test.tsx` — «Escape при фокусі на кнопці-іконці…» зі справжнім
слухачем на `document` (а не React-батьком, як у наявному тесті).

**Статус:** [x] виправлено

## Bug #784 — [LOW] Після Enter/Escape клік по полю дати не відкриває календар; кнопка-іконка без назви

**Файл:** `apps/web/src/components/ui/date-picker-input.tsx:149`, `:168` (стан до фіксу)
**Severity:** LOW
**Категорія:** frontend (регресія `918f21d9`) + a11y

**Опис:** календар відкривався лише на `onFocus`. До `918f21d9` закрити його можна було тільки
кліком поза компонентом або вибором дня — в обох випадках поле втрачало фокус, тож наступний
клік знову давав `focus`. Enter/Escape створили новий стан «фокус у полі, календар закритий»:
повторний клік по полю `focus` не генерує, і календар не відкривається (лишалась тільки іконка).
Попутно: у кнопки-іконки не було доступної назви (`<button>` лише з `<svg>`), хоча вона в
tab-порядку.

**Доказ (браузер):** фокус у полі → Escape → клік по полю → `{cal:0}`. Після фіксу → `{cal:1}`.

**Фікс:** `onClick={() => setOpen(true)}` на полі; `aria-label="Відкрити календар"` на кнопці.
**Тест:** «клік по вже сфокусованому полю після Escape знову відкриває календар».

**Статус:** [x] виправлено

### Підозри review — перевірено, НЕ баги

- **Enter у `DatePickerInput` усередині `<form>` сабмітить форму?** Ні, і не міг: у `apps/web/src`
  рівно один `<form>` — на `/login`, і `DatePickerInput` там немає. У браузері: `document.forms.length`
  = 0 на `/work-orders` і на `/invoices` з відкритою `InvoiceCreateModal`; Enter у полі дати з
  відкритим і з закритим календарем → модалка лишається, жодного не-GET запиту. Відносно `206df580`
  нічого не змінилось: новий обробник не чіпає типову дію Enter ні до, ні після.
- **Escape у фільтрі списку (поза модалкою) робить щось зайве?** Ні. `/work-orders`: фокус у
  «дата від» → Escape → календар закрито, URL той самий, діалогів 0. Через `useKeyboardShortcut`
  зареєстровано лише `ctrl+k`, `alt+*`, `n`, `?` — Escape серед них немає.

### Спостереження поза обсягом — НЕ виправлялись

- `apps/api/src/prisma/tenant-guard.integration.spec.ts:138` — `guarded.workOrder.deleteMany({ where: { deletedAt: null } })`
  під `rejects`. Поки guard працює, нічого не видаляється; якщо guard колись регресує, цей «має
  кинути» тест hard-delete-не всі наряди dev-БД. Варто звузити `where` до неіснуючого id.
- `scripts/check-spec-registry.py --gate-size` на успіху друкує `0 passed (0)` (gate B повертає
  кількість знайдених монолітів, а не перевірених файлів), і `verdict.sh` каже на це «ЧИСТО» —
  хоча для turbo той самий скрипт уже трактує «0 із 0» як «нічого не запускалось».
- Детектор «Escape на одному елементі складеного віджета» дає 6 кандидатів у
  `components/ui` (`columns-dropdown`, `entity-picker-field`, `InvoiceCreateModal`,
  `PurchaseOrderCreateModal`, `saved-filters-bar`, `search-combobox`) — не перевірялись.

---

## Session 2026-10-07 — Bug hunt `986e2240..HEAD` (селектор тестів `affected-tests.py`, Playwright на :3002, гейт C «Маршрути UI»)

Метод — мутаційний: у прод-файл вноситься зміна, що ламає поведінку, ганяється ПОВНИЙ набір
пакета і команда, яку для цього файла друкує селектор; тест, що впав у повному прогоні, мусить
бути у виборі. 16 unit-мутацій (api 7, web 7, `packages/shared` 2) і 4 E2E-мутації — разом 20.
Розбіжностей — чотири (a1, s1, s2, e3), вони дали три баги (#785, #786, #787); #788 знайдено
читанням виводу, не мутацією.

## Bug #785 — [HIGH] Селектор не вибирає спек, який читає код з диска (tenant-guard-static)

**Файл:** `scripts/affected-tests.py` — `select()`, гілка api-модуля (стан до фіксу)
**Severity:** HIGH
**Категорія:** tooling / tenant isolation

**Опис:** для файла api-модуля селектор друкує `vitest related <файл> <спеки теки модуля>`.
`vitest related` іде графом імпортів. `apps/api/src/prisma/tenant-guard-static.spec.ts` сервіси
не імпортує — він обходить `modules/**/*.service.ts` через `readdirSync`/`readFileSync` і шукає
`update/delete({ where: { id } })` без `orgId`. Тобто саме той спек, що стереже tenant isolation
статично (unit-специ мокають Prisma, і A1-guard у них не виконується), у локальний вибір не
потрапляв ніколи.

**Доказ (мутація):** `vehicles.service.ts:71` — `where: { id, orgId }` → `where: { id }`.
Повний api-набір: 1 файл червоний — `src/prisma/tenant-guard-static.spec.ts`. Команда селектора
(`vitest related "src/modules/vehicles/vehicles.service.ts" "…/vehicles.service.spec.ts"`):
зелена. Агент, що працює за інструкцією «локально лише зачеплене», отримав би зелений
прогін на записі без tenant-токена (у рантаймі — HTTP 500 від guard-а).

**Фікс:** `scanning_specs()` — тести, які читають файли з диска (`readFileSync`, `readdirSync`,
`globSync`, `import … from 'fs'`, `import.meta.glob`) І шукають їх від власного розташування
(`__dirname`, `process.cwd()`, `import.meta.url`), визначаються автоматично й додаються до
вибору при зміні будь-якого не-тестового файла пакета. Перелік вручну не ведеться. Спек, що
пише й читає власний тимчасовий файл (`bank-statement-parser.service.spec.ts`, `mkdtemp`),
сканером не вважається. Після фіксу та сама мутація вбивається командою селектора.

**Тест:** `scripts/test-affected-tests.py` — «спек, що читає код з диска (статичний детектор) →
у виборі для будь-якого файлу модуля».

**Статус:** [x] виправлено (`ca1186d3`)

## Bug #786 — [MEDIUM] Тест `packages/shared` не входить ні в «повний прогін» селектора, ні в CI

**Файл:** `scripts/affected-tests.py` — `render()`/`script_checks()`; `.github/workflows/ci.yml:55`
**Severity:** MEDIUM
**Категорія:** tooling / CI

**Опис:** для `packages/shared/**` селектор каже «ПОВНИЙ ПРОГІН» і друкує три команди —
API / WEB / E2E. Власний тест пакета (`packages/shared/src/i18n/key-parity.spec.ts`, 4 кейси:
парність ключів uk↔en, порожні значення, `VALIDATION_KEYS`, плейсхолдери) у жодну з них не
входить. Докстрінг селектора посилається на CI («ганяє все завжди»), але крок «Unit tests» у
CI фільтрував лише `@sto/api` і `@sto/web` — тобто цей спек не ганявся ніде, крім ручного
`pnpm test`.

**Доказ (мутації):** (1) видалено ключ `v.email` з `messages.en.ts` → shared червоний, api
червоний (`common/pipes/validation-i18n-parity.spec.ts` перекриває цей випадок), web зелений.
(2) `{{max}}` → `{{mx}}` у `messages.en.ts` → червоний ЛИШЕ `key-parity.spec.ts`; повні api і
web — зелені. Користувач en-локалі побачив би «{{max}}» у тексті.

**Фікс:** селектор для пакета з власними тестами друкує `ІНШЕ: cd packages/<name> && npx vitest run`
(пакет без тестів команди не отримує — вона впала б із «No test files found»); у CI до кроку
«Unit tests» додано `pnpm --filter @sto/shared run test`.

**Тест:** `scripts/test-affected-tests.py` — «пакет із власними тестами (packages/shared) → його
команда у виводі повного прогону».

**Статус:** [x] виправлено (`ca1186d3`)

## Bug #787 — [HIGH] Рядок `**Маршрути UI:**` ЗАМІНЯВ виведені маршрути; ребро «E2E-спек → API» не враховувалось

**Файл:** `scripts/affected-tests.py` — `module_routes()` (`if declared: return set(declared), None`), `select()`
**Severity:** HIGH
**Категорія:** tooling / E2E selection

**Опис:** дві причини одного пропуску.
(1) Якщо в дос'є є `**Маршрути UI:**`, селектор брав РІВНО ці маршрути і не дивився, які
сторінки звертаються до URL контролерів модуля. Для `counterparties` у дос'є стоїть
`/counterparties, /vehicles` — і це сховало 12 сторінок, де контрагента вибирають у документі
(наряди, рахунки, закупівлі, календар, оплати…).
(2) E2E-спеки самі ходять в API (`fetch(`${API}/counterparties?limit=1`)`), щоб узяти
контрагента для документа, який створюють. Це ребро не проходить через жодну сторінку —
ні маршрут, ні граф імпортів web його не бачать.

**Доказ (мутація, живий API на :3000):** `counterparties.service.ts` `findAll` → `items: []`.
Повний E2E (`--retries=1`): 13 failed, 1 flaky, 54 did not run; червоні 12 спек-файлів —
client-payments, crud-calendar-slot, crud-counterparty, crud-invoice, crud-purchase-order,
detail-panel-toggle, import-wizard, invoices, purchase-orders-receive, supplier-payments,
supplier-returns, work-orders-detail. Вибір селектора: 4 спеки (counterparty-detail, crm,
crud-counterparty, vehicles) — з червоних там був ОДИН.

**Фікс:** (1) рядок дос'є тепер ДОПОВНЮЄ виведене з коду: `declared ∪ однойменна сторінка ∪
сторінки з URL контролерів` (спільні файли, як і раніше, не враховуються; до «весь E2E» не
ескалюється). (2) `specs_calling()` — не наскрізні спеки, у тексті яких є URL контролерів
зміненого модуля, йдуть у вибір незалежно від маршруту. Після фіксу всі 12 червоних файлів
(і flaky crud-work-order) — у виборі; вибір для `counterparties` виріс із 4 до 35 спеків із 50,
і це чесна ціна: модуль справді використовується майже скрізь. Для решти api-модулів вибір
змінився лише в чотирьох (bank-statements +1, vehicles +1, dashboard +3, setup +3).

**Тест:** `scripts/test-affected-tests.py` — «**Маршрути UI:** доповнює виведене з коду…» і
«спек, який сам ходить в API модуля, у виборі…».

**Контроль після фіксу (нова мутація):** `vehicles.service.ts` `findAll` → порожній список.
Повний E2E: 2 червоні файли — `vehicles.spec.ts`, `work-orders-detail.spec.ts`; обидва у виборі
(другий — лише завдяки `specs_calling()`: спек ходить на `/work-orders`, а авто бере через API).

**Статус:** [x] виправлено (`cb46d0ff`)

## Bug #788 — [LOW] Зміна api, чию сторінку відвідує лише наскрізний спек: «E2E : —» і хибна примітка

**Файл:** `scripts/affected-tests.py` — `select()`, обчислення `no_e2e`
**Severity:** LOW
**Категорія:** tooling

**Опис:** для `apps/api/src/modules/setup/setup.service.ts` селектор друкував `E2E : —` і
`УВАГА: маршрути без жодного E2E-спека: setup`. Обидва твердження хибні: `/setup` відвідують
`smoke.spec.ts` і `api-errors.spec.ts`. Причина — наскрізні спеки виключені з пошуку за
маршрутом і для зміни лише api не додаються взагалі; для сторінки без власного спека вони
лишались єдиною вартою, яку селектор не називав. Знайдено читанням виводу, НЕ мутацією: тест
`/setup` у smoke сам читає `/setup/status` і підлаштовується під відповідь, тож убити його
зміною api не вдалось.

**Фікс:** маршрут без власного спека отримує ті наскрізні спеки, які його відвідують (літерал
у `goto`); примітка «без жодного E2E-спека» лишається лише для справді непокритих. Заодно
причина «використовується на 0+ сторінках» (модуль, який кличе оболонка) замінена на
«використовується оболонкою всіх сторінок».

**Тест:** `scripts/test-affected-tests.py` — «зміна api, чию сторінку відвідує лише наскрізний
спек → він у виборі, а не «E2E : —»».

**Статус:** [x] виправлено (`cb46d0ff`)

### Таблиця мутацій (сесія `986e2240..HEAD`)

| #   | Файл (мутація)                                                             | Упало в повному прогоні                                | Усе у виборі селектора?        |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| a1  | `vehicles.service.ts` — `where: { id }` без orgId                          | `prisma/tenant-guard-static.spec.ts`                   | НІ → Bug #785                  |
| a2  | `inventory.service.ts` — throw у `resolveCostMethod`                       | 2 файли inventory (12 тестів)                          | так                            |
| a3  | `document-number.service.ts` — throw у `next()`                            | `document-number.service.spec.ts` (7)                  | так                            |
| a4  | `invoices.dto.ts` — `@Min(0.01)` → `@Min(1000000)`                         | нічого (мутант вижив)                                  | — (прогалина покриття DTO)     |
| a4b | `goods.dto.ts` — прибрано `@Transform(trimQueryValue)`                     | `goods-query.dto.spec.ts` (2)                          | так                            |
| a5  | `invoice-overdue.processor.ts` — `OVERDUE` → `PAID`                        | `invoice-overdue.processor.spec.ts` (1)                | так                            |
| a6  | `email.provider.ts` — `sendMail` → `sendMailX` (ізольований проєкт vitest) | `email.provider.spec.ts` (3)                           | так                            |
| s1  | `packages/shared` `messages.en.ts` — видалено ключ                         | shared key-parity (2) + api validation-i18n-parity (2) | НІ (shared-спек) → Bug #786    |
| s2  | `packages/shared` `messages.en.ts` — `{{max}}` → `{{mx}}`                  | лише shared key-parity (1)                             | НІ → Bug #786                  |
| w1  | `lib/format.ts` — `fmtMoney` → `'MUT'`                                     | 4 файли (6 тестів)                                     | так                            |
| w2  | `hooks/api/useInvoices.ts` — URL transition                                | `useInvoices.test.tsx` (1)                             | так                            |
| w3  | `components/ui/button.tsx` — `{children}` → `{null}`                       | 24 файли (94 тести)                                    | так (1 файл у виборі не впав)  |
| w4  | `invoices/page.tsx` — текст кнопки                                         | нічого (unit-тесту сторінки немає)                     | — (ловить E2E, див. e1)        |
| w5  | `InvoiceCreateModal.tsx` — текст кнопки                                    | `DocumentCreateModals.test.tsx` (2)                    | так                            |
| w6  | `work-orders/[id]/InvoiceSection.tsx` — сума                               | `InvoiceSection.test.tsx` (1)                          | так (шлях із `[id]` і `(app)`) |
| w7  | `payroll/page.tsx` — ранній return                                         | 2 файли payroll (13)                                   | так                            |
| e1  | E2E: `invoices/page.tsx` — текст кнопки «Рахунок»                          | `crud-invoice`, `invoices`                             | так                            |
| e2  | E2E: `StockDocumentCreateModal.tsx` — «Створити документ»                  | `stock-documents`                                      | так                            |
| e3  | E2E: `counterparties.service.ts` — `findAll` → `[]` (живий API)            | 12 спек-файлів                                         | НІ (1 з 12) → Bug #787         |
| e4  | E2E: `vehicles.service.ts` — `findAll` → `[]` (після фіксу #787)           | `vehicles`, `work-orders-detail`                       | так                            |

w3: `QrPaymentModal.test.tsx` упав у повному прогоні й пройшов у вибраному (файл у виборі був) —
недетермінований під мутацією, не пропуск селектора.

### Спостереження поза обсягом — НЕ виправлялись

- **Мутант a4 вижив:** `@Min` на `CreateInvoiceDto.amount` не стереже жоден тест (повний api-набір зелений
  при `@Min(1000000)`).
- **w4:** у `invoices/page.tsx` немає unit-тесту — зміну тексту кнопки ловить лише E2E.
- **Гейт C і селектор мовчки відкидають маршрут із великою літерою** (`/Inventory` у `**Маршрути UI:**`):
  регекс `[a-z0-9-]+` його не бачить, рядок просто стає коротшим.
- **Видалений web-файл:** селектор не знаходить його в графі (файла вже немає) і друкує «не досягає
  жодної сторінки»; тести, що його імпортували, у вибір не йдуть. Ловить `tsc`, не селектор.
- **E2E-спек → API лише для модуля зміненого файла.** Для модулів-споживачів (ті, що імпортують
  змінений сервіс) правило `specs_calling()` не застосовується — свідомо, інакше зміна
  `settings.service.ts` давала б майже весь suite. Мутацією не перевірено.

---

## Session 2026-10-07 — Bug hunt `997cbdbb..HEAD` (розкладання скілів на ядро/секції/журнал, `check-skill-size.py`)

Продукт-код у діапазоні не мінявся. Обсяг: гейт розміру скілів як програма, правило селектора
для `.claude/skills/**`, придатність структури `sto-tester` на трьох уявних змінах, дослівність переносу.

## Bug #789 — [LOW] `check-skill-size.py`: вердикт залежав від ОС (регістр розширення, CRLF)

**Файл:** `scripts/check-skill-size.py:36` (`kb`), `:53` (обхід файлів)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** (1) `glob('**/*.md')` на Linux чутливий до регістру: файл `big.MD` гейт бачив на Windows
і пропускав у CI на ubuntu — хибне «зелено» саме там, де гейт обов'язковий. (2) Розмір брався з диска:
checkout із `core.autocrlf=true` додає байт на рядок (+2–3%), тож файл біля межі був би «понад ліміт»
локально і «в нормі» в CI. (3) Повідомлення для файла на 1 байт понад межу: «36 КБ (ліміт 36)».
**Очікувана поведінка:** однаковий вердикт на Windows і в CI для того самого вмісту.
**Фактична поведінка:** відтворено в тимчасовій копії `.claude/skills`: `.MD` 488 КБ — failed на
Windows; на Linux `glob` його не повертає. Реальних файлів у «плаваючій» зоні зараз немає
(найближчий — `sto-web/SKILL.md`: 94.3% ліміту як LF, 96.2% як CRLF).
**Статус:** [x] виправлено — обхід через `os.walk` + `lower().endswith('.md')`, розмір без CR, `%.2f`. Коміт `dd33a29f`.

## Bug #790 — [LOW] sto-tester: шість заголовків у переліках не давали обрати пункт за diff-ом

**Файл:** `.claude/skills/sto-tester/sections/s1-1-backend-logic.md`, `sections/s1-4-security.md`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** за заголовком пункт не обирався, а за повним текстом стосується зміни: `T1.1-019` («X налаштовано?» —
X не названо; текст про фіскального провайдера/платіжний шлюз/канал сповіщень), `T1.1-025` («Dead-feature
integration audit» — текст про сервіс із queue/processor, який не викликають payments/invoices), `T1.1-031`
(«довідниковий запис» — payment-method/tax-rate/template), `T1.1-033` («Soft string FK» — `paymentMethodCode`,
`eventType`), `T1.1-058` (`job.data`, DLQ), `T1.4-002` (єдине місце з правилом «external service → черга
attempts ≥ 10 + backoff» сховане під «Public endpoint double-strict audit»).
**Очікувана поведінка:** заголовка досить, щоб вирішити, чи діставати повний текст.
**Фактична поведінка:** для `payments.service.ts` і `sms.processor.ts` ці пункти лишались би непрочитаними.
**Статус:** [x] виправлено — уточнено заголовки в `sections/`; тексти в `journal/` не змінювались.

## Bug #791 — [LOW] sto-tester: матриця ядра не веде до частини потрібних пунктів

**Файл:** `.claude/skills/sto-tester/SKILL.md` (матриця AUTO, таблиця дос'є), `sections/s1-3-frontend.md`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** (1) для `page.tsx`/хука матриця дає лише §1.3, а 12 фронтенд-пунктів лежать у §1.1/§1.2
(`T1.1-011/012/021/037/039/040`, `T1.2-013/015/018/019/020/021`); (2) для BullMQ-процесора матриця дає
§1.1+§1.2, а правило про чергу/retry — у §1.4; (3) таблиця «ключові слова → дос'є» не знає `payments`,
`cash`, `supplier-payment`, `bank-statements`, `loyalty`, `payroll`, хоча дос'є існують.
**Очікувана поведінка:** матриця приводить до всіх пунктів, що стосуються типу зміни.
**Фактична поведінка:** розташування пунктів успадковане від монолітного файла, де секції читались підряд.
**Статус:** [x] виправлено — перехресна примітка на початку `s1-3`, «+ §1.4» у рядку процесора, рядок
«інший модуль» у таблиці дос'є. Пункти між секціями не переносились.

## Bug #792 — [LOW] sto-tester: у трьох пунктів продовження лишилось у переліку, а не в журналі

**Файл:** `.claude/skills/sto-tester/journal/details-1-3.md` (`T1.3-049`), `journal/details-1-5.md` (`T1.5-008`, `T1.5-013`)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** блок коду й абзац після нього (детектор, спосіб перевірки) стоять у `sections/` під заголовком
пункту, а в `journal/` їх немає: `awk` з початку переліку для `T1.3-049` повертає текст, що обривається на
«Кандидати:». Знання не втрачено і до сусіднього пункту воно не поїхало (порядок збережено), але обіцянка
«повний текст — у journal» для 3 зі 180 пунктів не виконується.
**Очікувана поведінка:** продовження пункту — разом із його повним текстом.
**Фактична поведінка:** продовження видно лише тому, хто читає перелік.
**Статус:** [x] виправлено частково — у заголовках трьох пунктів сказано, що детектор стоїть під пунктом;
`journal/` свідомо не чіпався (обмеження сесії). Перенос блоків у журнал — окреме рішення.

---

## Session 2026-10-07 — Bug hunt `6319d3ec..HEAD` (BR-WO-001: акт переводить наряд у INVOICED через FSM + CAS)

Продукт-код діапазону: `work-order-status.ts` (новий хелпер), `completion-acts.service.ts`, `.controller.ts`.
Обсяг після review: живий діагноз нумерації актів, гонка на живій dev-БД, підписання акта для
скасованого наряду, покриття нового коду. Тимчасові рядки з dev-БД прибрано (звірка `count(*)` усіх
таблиць до і після — без різниці; лічильник `INVOICE` повернуто на попереднє значення).

## Bug #793 — [HIGH] Скасування акта перезаписувало щойно підписаний акт (гонка `cancel()` × `sign()`)

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:266` (`cancel`)
**Severity:** HIGH
**Категорія:** business-logic

**Опис:** `cancel()` читав статус (`findFirst`), перевіряв «не SIGNED» і писав `update({ where: { id, orgId } })`
без предиката на статус. Коментар у коді стверджував «race-safe». `sign()`, що закомітився між читанням і
записом, мовчки перезаписувався. Код поза діапазоном (не чіпався BR-WO-001), знайдено тим самим стендом гонки.
**Очікувана поведінка:** рівно один переможець: або акт SIGNED (скасування → 400 «Підписаний акт не можна
скасувати»), або акт CANCELLED (підписання → 400).
**Фактична поведінка:** відтворено на живій dev-БД — пари запитів `PATCH …/sign` + `DELETE …/:id` зі зсувом
0–20 мс: у 6 із 40 обидва повернули успіх (200 і 204), підсумок: акт `CANCELLED`, наряд `INVOICED`, рахунок
виставлено. Підписаний юридичний документ зникає зі списку (`findAll` ховає CANCELLED), а для наряду можна
створити другий акт.
**Статус:** [x] виправлено — CAS `updateMany` з `status: { not: SIGNED }` у `where`, 0 рядків → 400. Після
виправлення той самий стенд: 0 порушень із 40. Три unit-тести, мутації «ігнорувати count=0» і «прибрати
предикат» вбиті. Коміт `f62f3b70`.

## Bug #794 — [CRITICAL] Нумерація документів: `COMPLETION_ACT` не має конфігурації ніде; `/setup/init` створює 8 типів із 13

> **ВИПРАВЛЕНО 2026-10-07.** `/setup/init` бере типи з `document-number-defaults.ts` —
> `Record<DocumentType, …>`, тож новий тип enum не скомпілюється без рядка там. Міграція
> `20261007120000_backfill_missing_document_number_configs` додає п'ять відсутніх типів наявним
> організаціям (ідемпотентно, наявні префікси й лічильники не чіпає); seed отримав
> `COMPLETION_ACT` («АВР»). На dev-БД міграцію застосовано: 13 типів із 13.
> НЕ перевірено: чиста інсталяція через інсталятор і створення акта через UI.

**Файл:** `packages/database/prisma/seed.ts:162` (`docConfigs`), `apps/api/src/modules/setup/setup.service.ts:89` (`docTypes`),
`packages/database/prisma/migrations/` (немає backfill для двох типів)
**Severity:** CRITICAL
**Категорія:** business-logic

**Опис:** `DocumentNumberService.next()` кидає 404, якщо для пари (org, тип) немає рядка `document_number_configs`.
Рядки створюють три місця, і вони розійшлися з enum `DocumentType` (13 значень):

| Тип                      | `seed.ts` (dev) | `/setup/init` (чиста інсталяція) | backfill-міграція              | Хто кличе `next()`                              |
| ------------------------ | --------------- | -------------------------------- | ------------------------------ | ----------------------------------------------- |
| `COMPLETION_ACT`         | немає           | немає                            | немає                          | `completion-acts.service.ts:165`                |
| `COUNTERPARTY_AGREEMENT` | є               | немає                            | немає                          | `counterparties.service.ts:219`, `:652`         |
| `SUPPLIER_RETURN`        | є               | немає                            | `20260615120100` (існуючі org) | `supplier-returns.service.ts:177`               |
| `GOOD_INTERNAL_CODE`     | є               | немає                            | `20260619140001` (існуючі org) | `goods.service.ts:192` — кожне створення товару |
| `SUPPLIER_PAYMENT`       | є               | немає                            | `20260703100001` (існуючі org) | `supplier-payments.service.ts:609`              |

Решта 8 типів є всюди. `RECONCILIATION_ACT` конфіг має, але `next()` для нього ніхто не кличе.

**Очікувана поведінка:** кожен тип, для якого код кличе `next()`, має конфіг у кожній org — і в dev, і після
`/setup/init`, і в org, що існувала до появи типу.
**Фактична поведінка:**

- **dev-БД (перевірено запуском):** у `document_number_configs` 12 типів, бракує лише `COMPLETION_ACT`.
  `POST /api/v1/completion-acts/from-work-order/7299ff2b-…` (наряд COMPLETED без акта) → `404 «Конфігурацію
нумерації для "COMPLETION_ACT" не знайдено»`. У таблиці `completion_acts` 0 рядків за весь час — акт не
  створювався жодного разу, тобто `sign()` (і весь BR-WO-001) через UI недосяжний.
- **чиста інсталяція (за кодом, не запуском):** `installer/scripts/First-Run.ps1` виконує лише
  `prisma migrate deploy` (seed свідомо вимкнено, H-1). Backfill-міграції відпрацьовують на порожній
  `organisations` і нічого не вставляють; org створює `/setup/init` уже після них — із 8 типами. Бракує всіх
  п'яти: не створюються товар (будь-який), контрагент типу SUPPLIER/BOTH і договір, повернення постачальнику,
  оплата постачальнику, акт виконаних робіт.
- **org, що існувала до міграцій:** три типи отримала backfill-ом; `COMPLETION_ACT` і `COUNTERPARTY_AGREEMENT` — ні.
- UI налаштувань не рятує: `PATCH /settings/document-numbers/:type` лише оновлює наявний рядок.
- `setup.service.spec.ts:51` мокає `createMany` з `count: 8` — перелік типів не звіряється з enum.
- Побіжно: префікси в `seed.ts` і `/setup/init` різні (`НРД`/`НЗ`, `РАХ`/`РФ`, `ЗАМ`/`ПО`, …).

Пункт чекліста `T1.1-060` цей клас описує (Bug #533), але перевіряє лише появу нового значення enum у diff-і —
старі пропуски він не знаходить.
**Статус:** [ ] відкритий — не виправлялось свідомо: потрібні backfill-міграція, рядки в `seed.ts` і
`setup.service.ts`, рішення власника про префікс акта і про єдиний набір префіксів. Варто додати тест
«`docTypes` у setup = усі значення `DocumentType`, для яких є виклик `next()`».

## Bug #795 — [MEDIUM] Акт підписується для вже скасованого наряду (правила немає, рішення за власником)

> **ВИПРАВЛЕНО 2026-10-07** за рішенням власника — обидва запобіжники (BR-WO-006):
> `WorkOrdersService.transition()` при переході в `CANCELLED` скасовує чернетки актів наряду в
> тій самій транзакції; `CompletionActsService.sign()` для скасованого наряду кидає 400
> «Наряд скасовано — акт підписати не можна». Наряд у `INVOICED`/`PAID`/`ARCHIVED` підпис
> дозволяє. Обидві гілки вбиті мутаціями. Наживо не перевірено.

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:184` (`sign`)
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `sign()` дивиться на статус наряду лише щоб вирішити, чи робити перехід COMPLETED→INVOICED. Акт,
створений поки наряд був COMPLETED, лишається DRAFT після `COMPLETED→CANCELLED` (скасування повертає запчастини
і сторнує борг, актів не чіпає) — і підписується. Після BR-WO-001 це ще й природне продовження гонки: програвший
`sign()` дістає «Статус наряду змінився — повторіть дію», а повтор підписує акт уже скасованого наряду.
**Очікувана поведінка:** не визначена — бізнес-правила немає.
**Фактична поведінка** (зафіксовано unit-тестом «наряд уже CANCELLED → акт усе одно стає SIGNED…», мутаційно
доведено): акт `SIGNED`; статус наряду не чіпається; події переходу немає; авто-рахунок відхилено
(`err.invoice.onlyCompletedInvoiceable`) і проковтнуто у `logger.warn` — користувач бачить успіх.
Що лишається неузгодженим:

- грошей і складу це не зачіпає: рахунку немає, борг уже сторновано, запчастини повернуто;
- лишається юридичний документ «роботи виконано й прийнято» для наряду, якого за обліком не було;
- стан незворотний через API: підписаний акт не скасовується (`signedNotCancelable`), зняти підпис нічим;
- за кодом (не запуском): CANCELLED-наряд можна видалити (`DELETABLE_STATUSES`), `remove()` актів не перевіряє —
  підписаний акт лишиться активним при soft-deleted наряді.

**Статус:** [ ] відкритий — поведінку НЕ змінено: заборонити підпис поза `INVOICEABLE_STATUSES` чи скасовувати
чернетки актів при `CANCELLED` — нове бізнес-правило. Тест стане червоним, щойно правило з'явиться.

## Bug #796 — [MEDIUM] Гілки нового коду BR-WO-001 без тесту

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.spec.ts`, `apps/api/src/modules/work-orders/work-order-status.spec.ts`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:** мутації, які до цієї сесії не валили жодного тесту:

- емісія події лише за наявності `userId` (гейт перенесено з хендлера в сервіс);
- емісія всередині транзакції, до коміту (подія й аудит про перехід, який відкотився);
- контролер не передає `user.id` → перехід COMPLETED→INVOICED лишається без запису аудиту;
- дозволена ціль хелпера (`PAID`, `ARCHIVED`, …) помилково позначена як «має side-effects» — тести тримали
  лише `COMPLETED→INVOICED` і три заборонені цілі.

**Очікувана поведінка:** кожна з цих мутацій валить тест.
**Фактична поведінка:** усі виживали.
**Статус:** [x] виправлено — 5 кейсів у спеці акта (подія без `userId`; коміт не відбувся; довільний збій
авто-рахунку; контролер; поточна поведінка Bug #795) і матриця `from × to` у спеці хелпера. Мутації M1–M4, M7,
M8 вбиті. Гілка `act.workOrder` = null тестом не покрита свідомо: зв'язок у схемі обов'язковий
(`workOrderId` NOT NULL + FK), стан недосяжний. Коміт `f62f3b70`.

## Bug #797 — [LOW] E2E «FSM кнопки відповідають статусу наряду» падав, коли паралельний тест видаляв той самий наряд

**Файл:** `apps/web/e2e/crud-work-order.spec.ts:146` (`gotoFirstWoDetail`), `:191`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** хелпер брав найновіший наряд (`?limit=1`), а CRUD-тест того самого файла в паралельному воркері саме
створює і видаляє найновіший. Між запитом id і відкриттям картки наряд зникав. Окремо: регекс статус-бейджа не
знав «Призупинено» і «Скасовано» — на такому наряді тест упав би вже стабільно.
**Очікувана поведінка:** тест не залежить від рядка, який паралельно видаляє сусід.
**Фактична поведінка:** у прогоні 15 спеків селектора — 1 flaky: перша спроба «Наряд не знайдено»
(`error-context.md`), retry зелений. До змін діапазону стосунку не має.
**Статус:** [x] виправлено — хелпер бере останній із двадцяти найновіших, регекс доповнено. Саму гонку не
відтворював (вона залежить від розкладу воркерів): після правки три спеки нарядів з `--repeat-each=2` — 52 passed,
0 flaky; це перевірка «не зламав», а не доказ, що flake зник.

---

## Session 2026-10-07 — Bug hunt `98822531..HEAD` (історія пробігу авто: `GET /vehicles/:id/mileage`, секція в картці)

Перевірено живий endpoint на dev-БД (тимчасові авто й наряди, створені через API і прибрані soft delete),
секцію в браузері на :3002 (світла/темна тема, 360 px, порожній стан, помилка з «Повторити»), свіжість кешу.
У dev-БД до сесії не було жодного наряду з пробігом — усі 19 авто віддавали `[]`, тож реальні дані фічу не вправляли.

## Bug #798 — [MEDIUM] Наряд, відкритий того ж дня після завершеного, робить завершений «відкатом пробігу»

**Файл:** `apps/api/src/modules/vehicles/vehicles.service.ts:216` (ключ сортування) і `:222` (порівняння)
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** Дата запису — `completedAt ?? documentDate`. `completedAt` — момент, а `documentDate` — `@db.Date`,
тобто дата без часу; Prisma віддає її як опівніч UTC. Сортування порівнювало їх як мітки часу, тому незавершений
наряд завжди ставав на 00:00Z свого дня — раніше за будь-який наряд, завершений того ж дня.
**Як відтворити (зроблено на живому API):** авто без історії → наряд №1091: `inMileage 50000`, робота,
`outMileage 50100`, перехід до `COMPLETED` (completedAt `2026-10-07T17:23:57Z`) → того ж дня новий наряд №1092 з
`inMileage 50200`, лишити чернеткою → `GET /vehicles/:id/mileage`.
**Очікувана поведінка:** №1091 (50 100), №1092 (50 200), відкатів немає.
**Фактична поведінка:** №1092 (50 200, дата `…T00:00:00Z`), потім №1091 (50 100) з `isRollback: true`; у картці
авто — жовтий рядок «Пробіг менший за попередній» і приріст «−100» на справному авто.
**Статус:** [x] виправлено — записи впорядковуються за календарним днем за Києвом (`kyivYmd(completedAt)` /
дата `documentDate`), у межах дня — за номером наряду (як і було сказано в BR-VEH-002 для «рівної дати»).
BR-VEH-002 у `docs/objects/vehicle.md` уточнено. Наслідок для графіка: `date` у межах одного дня тепер може не
зростати, тож `MileageChart` не дає X спадати (інакше лінія йшла б справа наліво). Регресія: два кейси в
`vehicles.mileage-history.spec.ts` (обидва червоні на старому коді; другий червоний і на мутації «день UTC
замість київського») + кейс у `MileageChart.test.tsx`. Після фіксу той самий сценарій на живому API дає
№1091, №1092 без відкатів.
**Рішення, яке варто знати власнику:** у межах одного дня порядок тепер за номером наряду, а не за часом
завершення — два наряди, ЗАВЕРШЕНІ одного дня, теж ідуть за номером. Інший варіант (час створення наряду)
точніший, але це вже нове правило, а не уточнення наявного.

## Bug #799 — [LOW] Після виправлення пробігу в картці наряду картка авто до 60 с показує стару історію

**Файл:** `apps/web/src/hooks/api/useVehicleMileage.ts:15` (`staleTime: 60_000`)
**Severity:** LOW
**Категорія:** frontend

**Опис:** Кеш `vehicleMileageKeys` скидався лише через `invalidateWorkOrderSideEffects`, тобто на перехід статусу
й видалення наряду. Збереження реквізитів у картці наряду (`saveEdit`: `inMileage`, `documentDate`) і створення
наряду (три місця з `CreateWorkOrderModal`) цього кешу не чіпають, а ще є планшет механіка й інші користувачі.
**Як відтворити (зроблено в браузері):** картка авто з рядком-відкатом (99 000) → клік по номеру наряду в
таблиці історії → виправити пробіг на 100 900 (PATCH 200) → «Назад».
**Очікувана поведінка:** рядок показує 100 900 без попередження.
**Фактична поведінка:** «99 000 · Пробіг менший за попередній · −1 800» ще до хвилини — тобто саме той шлях,
який секція підказує («побачив відкат → відкрив наряд → виправив»), завершувався старим попередженням.
**Статус:** [x] виправлено — `staleTime: 0`: історія перечитується на кожне відкриття картки (решта картки й
так вантажиться заново), `gcTime` лишено, тому скелетон при поверненні не блимає. Точкова інвалідація в
`saveEdit` закрила б одне місце з п'яти, тому обрано один фікс у хуку. Регресія: кейс у
`useVehicleMileage.test.tsx` (червоний на `60_000`). Після фіксу зворотний сценарій у браузері (100 900 → 99 000)
показує відкат одразу після повернення.

## Bug #800 — [MEDIUM] Ролі, `ParseUUIDPipe` і дві гілки правил нового endpoint-а без тесту

**Файл:** `apps/api/src/modules/vehicles/vehicles.controller.ts:100`, `apps/api/src/modules/vehicles/vehicles.mileage-history.spec.ts`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:** (1) contract-спеку контролера не було: заміна `MECHANIC` на `STOREKEEPER` у `@Roles` або зняття
`ParseUUIDPipe` лишали всі тести зеленими. (2) BR-VEH-003 на межі обрізання BR-VEH-005: чи лишається
`isRollback` у першого запису вікна, коли його попередника відрізано, — код це робить, тест не перевіряв.
(3) BR-VEH-004 «той самий текст, що в `GET /vehicles/:id`» — перевірявся лише клас винятку.
**Очікувана поведінка:** кожне з трьох ловиться тестом.
**Фактична поведінка:** не ловилося жодне.
**Статус:** [x] виправлено — `vehicles.contract.spec.ts` (15 кейсів, `RolesGuard` справжній: 4 ролі → 200,
STOREKEEPER/ACCOUNTANT/XLSX_MANAGER/CLIENT → 403, не-UUID → 400, 404 з текстом сервісу; мутації ролі й pipe
валять 5 кейсів) + 3 кейси в `vehicles.mileage-history.spec.ts`. Реєстр дос'є і `test-baseline.json` оновлено.
Живі 403 для ролей не перевірялись: у сесії E2E є лише адміністратор.

---

## Session 2026-10-08 — Bug hunt `28f93ad0..HEAD` (захід «борг специфікацій»: живі перевірки шести змін поведінки)

Перевірялось наживо через API (`127.0.0.1:3000`, сесія E2E-suite) і в браузері (`:3002`): BR-CP-001,
Bug #795 / BR-WO-006 (зокрема одночасність «підписати ‖ скасувати»), послідовне проведення рядків
складського документа, графік ТО видаленого авто, пошук робіт із trgm-індексом. Тестові дані — префікс
`TESTERDEBT`.

## Bug #801 — [MEDIUM] Складський документ на 500 рядків не проводиться: транзакція впирається у фіксовані 15 с

**Файл:** `apps/api/src/modules/stock-documents/stock-documents.service.ts:500` (до фіксу — `{ timeout: 15_000 }`)
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** DTO пропускає до 500 рядків (`@ArrayMaxSize(500)`), рядки проводяться послідовно (BR-SDOC-004), а
бюджет транзакції проведення був фіксований — 15 с. `TRANSFER` робить два рухи на рядок і на dev-БД коштує
≈ 28 мс/рядок на чистих товарах; що більше партій накопичив товар, то дорожче списання FIFO.
**Як відтворити (зроблено на живому API, заміри через `127.0.0.1`):** 10 товарів, документи по 500 рядків
(по 50 рядків на товар). Перший прохід: `OPENING_BALANCE` 8,6 с, `TRANSFER` **14,3 с**, `WRITEOFF` 6,3 с — усі 201. Другий прохід на тих самих товарах (у кожного вже є історія партій): `TRANSFER` →
**500 «Внутрішня помилка сервера» через 15,1 с**, документ лишився `DRAFT`, усі рухи відкочено.
Документи на 250 рядків проходять із запасом: 4,5 с / 7,0 с / 3,2 с.
**Очікувана поведінка:** документ, який пройшов валідацію, проводиться.
**Фактична поведінка:** на межі розміру — 500 без пояснення; користувач мусить сам здогадатись розбити документ.
**Чи це регресія заходу:** ні за швидкістю (стара версія з `Promise.all` на тому самому наборі дала
`OPENING_BALANCE` 6,9 с — того самого порядку), але стара версія такий `TRANSFER` не проводила взагалі:
400 «Партію змінено іншою транзакцією» — саме те, що виправив `b1abe415`. Тобто великий документ з
повторами товару став можливим лише в цьому заході, і ліміт 15 с виявився наступною стіною.
**Статус:** [x] виправлено — `confirmTxTimeoutMs(n) = max(15 с, n × 120 мс)` (×4 від заміряного; 500 рядків →
60 с), правило `BR-SDOC-008` у дос'є. Регресія: 6 кейсів у `stock-documents.receipt-type.spec.ts` (п'ять
значень функції + «`$transaction` отримує таймаут із кількості рядків»; повернення `15_000` валить кейс).
Після фіксу той самий документ-чернетка проведено наживо: 201 за 15,0 с, далі `WRITEOFF` 500 рядків 6,3 с,
залишок по всіх десяти товарах 0.

## Bug #802 — [LOW] `PATCH /maintenance-schedules/:id` для графіка видаленого авто відповідає 200 із даними

**Файл:** `apps/api/src/modules/maintenance-schedules/maintenance-schedules.service.ts:120`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `8a2ec1dd` додав `vehicle: { deletedAt: null }` у `findOne` (BR-MAINT-005), але читання-guard у
`update` лишилось без цього фільтра. Той самий id: GET — 404, PATCH — 200 і повний DTO графіка.
**Як відтворити (зроблено на живому API):** авто → графік ТО → `DELETE /vehicles/:id` →
`GET /maintenance-schedules/:id` дає 404 «Графік ТО не знайдено», а `PATCH` з `{ intervalDays: 90 }` — 200.
**Очікувана поведінка:** PATCH → 404, як і GET.
**Фактична поведінка:** 200, запис змінено, у відповіді — дані графіка, якого «не існує».
**Статус:** [x] виправлено — той самий фільтр у guard-і `update`; `remove` свідомо без нього (графік
видаленого авто можна прибрати). Регресія: кейс у `maintenance-schedules.service.spec.ts` (без фільтра
червоний). Наживо після фіксу: PATCH живого авто 200, видаленого — 404. SMS-нагадування зачеплені не були:
`followup.processor.ts:129` відсіює видалене авто сам.

## Bug #803 — [LOW] Нестабільний тест шифрування: секрет `'r1'` шукається підрядком у випадковому шифротексті

**Файл:** `apps/api/src/prisma/field-encryption.extension.spec.ts:281` (тест із `bd9dc696`)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** кейс `upsertConfig FISCAL/checkbox` перевіряв «секрету немає в параметрах SQL» через
`args.filter(a => a.includes(secret))` по ВСІХ параметрах, включно із шифротекстом. Шифротекст —
випадковий base64 довжиною близько 110 символів, а один із «секретів» — `cashRegisterId: 'r1'` (два
символи з алфавіту base64). Збіг трапляється приблизно у 2–3% прогонів.
**Як відтворено:** повний прогін api — `1 failed | 3697 passed`: «секрет r1 у параметрах SQL: expected
[ 'enc:v1:…z20OTNj5P0y8nSsBRK72fA449PF93Ot3or1imm4t…' ] to deeply equal []» — у шифротексті є `r1`.
Наступні прогони того самого коду зелені.
**Очікувана поведінка:** тест падає лише на справжній витік.
**Фактична поведінка:** випадкове падіння без витоку — червоний CI на чужому коміті.
**Статус:** [x] виправлено — відкритий текст шукається лише серед параметрів БЕЗ префікса шифротексту;
сам шифротекст, як і раніше, перевіряється розшифруванням. Мутація «шифрування вимкнено»
(`prisma.service.ts:134`) валить усі п'ять кейсів `upsertConfig` — сторож не ослаб.

---

## Session 2026-10-08 — Bug hunt `832d749d..HEAD` (грошові модулі: звіти, онлайн-оплата, платник рахунку, акт звірки, зарплата — живі перевірки)

Жива перевірка через API й UI (`:3002`), дані з префіксом `TESTERMONEY`. Правила BR-RPT-022,
BR-PAY-016, BR-SETL-011, BR-PAYR-001/006/015 наживо підтверджено. Знайдено три дефекти.

## Bug #804 — [CRITICAL] Онлайн-оплата: опитування шлюзу обривається після першого запиту — оплачений QR не стає платежем

**Файл:** `apps/api/src/modules/payments/payment-polling.processor.ts:213-236` (`enqueueNextPoll`) і `:330-341` (повтор finalize)
**Severity:** CRITICAL
**Категорія:** business-logic

**Опис:** опитування — це self-re-enqueue: задача сама ставить наступну. Наступна ставилась під ТИМ
САМИМ `jobId` (`payment-poll-<намір>`), що й поточна. BullMQ мовчки відкидає `add` з id задачі, яка
ще існує, а активна задача існує до завершення `process`. Тобто наступне опитування не ставилось
ніколи — ні після «pending», ні після збою шлюзу (BR-PAY-007 із `bb250a77`/`9cec93f1`), ні повтор
finalize. Намір опитувався рівно один раз, через 5 с після створення QR; клієнт, що заплатив
пізніше, лишав намір `PENDING` назавжди — гроші в шлюзі є, платежу й проводки немає.
Unit-спек цього не бачив: черга замокана, а асерти прямо вимагали той самий `jobId`.
**Як відтворено:** (1) ізольована черга на dev-Redis, BullMQ 5.81.4: задача ставить наступну під
своїм `jobId` — виконано 1 крок із 5, `add` повернув об'єкт задачі без помилки. (2) Новий
інтеграційний спек зі справжньою чергою і справжнім процесором на старому коді: «expected getStatus
to be called 5 times, but got 1 times». Наживо через шлюз не відтворювалось: еквайринг у dev-БД не
налаштовано, а SSRF-guard не пускає `apiUrl` на локальний макет.
**Очікувана поведінка:** поки намір `PENDING`, кожен крок ставить наступний; оплата доходить до платежу.
**Фактична поведінка:** одне опитування — і тиша.
**Статус:** [x] виправлено — `jobId` наступного кроку унікальний і детермінований
(`payment-poll-<намір>-p<крок>` / `-f<спроба>`); дубль того самого кроку, як і раніше, зливається.
Регресія: `payment-polling.queue.integration.spec.ts` (живий Redis: 2 збої + 2 «pending» + «paid» →
5 звернень до шлюзу, намір `PAID`, платіж один) і оновлені асерти `jobId` в unit-спеку. Мутація
«спільний jobId» валить 5 кейсів (4 unit + інтеграційний).
**Той самий дефект поза цими змінами (не виправлено, лише зафіксовано):**
`purchase-orders/delivery/nova-poshta-polling.processor.ts:155` — трекінг Нової пошти ставить
наступне опитування під `np-poll-<замовлення>`, id активної задачі.

## Bug #805 — [MEDIUM] E2E зарплати суперечить правилу «наряд — в одну відомість» і назавжди забирає наряди бази

**Файл:** `apps/web/e2e/payroll.spec.ts:87-240`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:** три дефекти одного спеку, що проявились після BR-PAYR-015 (`493dca34`).
(1) Тест життєвого циклу розраховує й ВИПЛАЧУЄ відомість за 2020–2030. Виплачену відомість видалити
не можна, а наряд тепер входить лише в одну — кожен прогін назавжди забирав усі ще не нараховані
наряди бази у тестову виплату. (2) Тест drill-down одразу після цього створює другу відомість за той
самий діапазон і вимагає в ній розшифровку по нарядах («seed завжди має завершені наряди») — нарядів
уже немає, усі в першій. На чистій базі CI seed нарядів узагалі не створює. (3) Прибирання в
`afterAll` не працювало: токен читався із `sessionStorage` одразу після `goto`, до гідрації, `expect`
падав, помилку ковтав `.catch(() => {})`. У dev-БД накопичилось 66 розрахованих `[e2e]`-відомостей
за 2020–2030, і кожна тепер тримала б наряди.
**Як відтворено:** через API на dev-БД: відомість A за 2020–2030 → розрахунок (3 рядки, розшифровка
є); відомість B за той самий діапазон → розрахунок: 1 рядок (окладник), `hasWo = false` — умова
тесту drill-down. Обидві видалено.
**Очікувана поведінка:** спек зелений за чинного правила і не лишає в базі відомостей, що тримають наряди.
**Фактична поведінка:** drill-down червоний; після кожного прогону наряди бази замкнені у виплаченій
тестовій відомості.
**Статус:** [x] виправлено — виплата й FSM-guard ідуть у порожньому вікні 2099-01; drill-down сам
створює завершений наряд, а наприкінці видаляє відомість і скасовує та видаляє наряд; `token()`
чекає гідрації (`expect.poll`). Прогін спеку: 7 passed; у dev-БД 141 → 75 відомостей (66 завислих
розрахованих прибрало штатне прибирання). Виплачені `[e2e]`-відомості за 2020–2030 (70 шт.)
лишаються: видалити їх не можна.

## Bug #806 — [MEDIUM] Інтеграційний спек нарахування зарплати не виконується в CI

**Файл:** `.github/workflows/ci.yml:266` (job `integration-tests`), `apps/api/src/modules/payroll/payroll.accrual.integration.spec.ts:103-124`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:** `493dca34` додав `payroll.accrual.integration.spec.ts` — єдине місце, де сирий SQL
«наряд уже в іншій відомості» і блокування організації справді виконуються. Job `integration-tests`
запускає специ за ЯВНИМ списком шляхів, і нового файла в списку немає; у звичайному unit-job БД
немає, тож спек іде у skip. Якби його просто дописали в список, він упав би: дані для наряду спек
брав із «будь-якого наявного наряду», а seed нарядів не створює (з `REQUIRE_DB=1` це помилка).
**Очікувана поведінка:** спек виконується в CI на чистій базі з seed.
**Фактична поведінка:** у CI не запускається взагалі; правило BR-PAYR-015 стережуть лише unit-спеки
з моком `$queryRaw`.
**Статус:** [x] виправлено — спек бере філію, авто, контрагента й валюту з довідників seed; у список
job-а додано його і спек черги з Bug #804, job-у додано сервіс Redis і `REQUIRE_REDIS=1`. Локально з
`REQUIRE_DB=1`: 7 passed. Сам CI цим заходом НЕ запускався.

---

## Session 2026-10-08 — Bug hunt `dd391bf0..HEAD` («ПДВ у сумі наряду»: живі перевірки трьох режимів ПДВ)

## Bug #807 — [LOW] Акт виконаних робіт без ПДВ друкує суму рядків, а не суму наряду: розходиться з боргом на копійку

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:382`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `generatePdf` брав суму наряду лише коли в ній є ПДВ (`vatTotal > 0 ? woTotal : linesTotal`),
а без ПДВ — суму рядків акта. Коментар стверджував, що без ПДВ ці суми збігаються, але наряд
округлює суму рядків РАЗ, а рядки акта округлені кожен окремо. Наживо, режим «без ПДВ», наряд
НРД-2026-001245 (3 роботи 0,3 × 111,11 і запчастина 0,07): борг клієнта й рахунок 100,07, акт —
«Разом: 100,06». У режимах із ПДВ той самий наряд давав в акті 100,07 / 120,08 — як у боргу.
**Очікувана поведінка:** сума акта = сума наряду до сплати в усіх режимах (BR-WO-007).
**Фактична поведінка:** без ПДВ (і для нарядів «старої моделі») акт на копійку менший за борг.
**Статус:** [x] виправлено — `total = woTotal` завжди, коли акт має наряд; сума рядків лишилась
тільки для акта без наряду. Регресійний кейс у `completion-acts.pdf-totals.spec.ts`.

## Bug #808 — [MEDIUM] Звіт «Виручка»: наряди, завершені між 00:00 і 06:00 за Києвом, потрапляють у рядок попереднього дня

**Файл:** `apps/api/src/modules/reports/reports.service.ts:77`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `DATE_TRUNC('day', "completedAt" AT TIME ZONE 'Europe/Kyiv')`: `completedAt` — timestamp без
зони в UTC, і один `AT TIME ZONE` читає його як київський час, тобто зсуває на 3 години НАЗАД, а не
вперед. Фільтр періоду при цьому рахується правильно (`normalizeDateRange`), тож наряд у вибірку
потрапляє, а підписується вчорашньою датою. Наживо: `GET /reports/revenue?from=2026-10-08&to=2026-10-08`
віддавав два рядки — «2026-10-07» (22 наряди, завершені 2026-10-07 22:xx UTC = 01:xx 08.10 за Києвом)
і «2026-10-08» (10 нарядів). Дефект старий (2026-06-03), знайдений при звірці трьох величин BR-RPT-023.
**Очікувана поведінка:** рядок дня = київська дата завершення; дати рядків не виходять за період.
**Фактична поведінка:** нічні завершення йдуть у попередній день, зокрема в дату поза запитаним періодом.
**Статус:** [x] виправлено — `AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv'`. Наживо після фіксу той
самий запит дає один рядок «2026-10-08». Unit-кейс стереже текст запиту (`$queryRaw` у спеку —
мок); межі 21:00 / 03:00 UTC і зимовий час перевірено SQL-ом на dev-базі.

## Bug #809 — [LOW] Нестабільний web-тест `QrPaymentModal` — `onPaid` перевірявся до пасивного ефекту

**Файл:** `apps/web/src/components/ui/__tests__/QrPaymentModal.test.tsx:109`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** тест чекав на текст «Оплачено» і одразу стверджував `onPaid` викликано 1 раз. `onPaid`
кличе пасивний `useEffect` ПІСЛЯ коміту, що намалював текст; оновлення приходить із таймера React
Query поза `act`, тож між текстом і ефектом є проміжок. Під навантаженням (повний web-набір поруч)
відтворено з третьої спроби: `expected "vi.fn()" to be called 1 times, but got 0 times` через
3052 мс. Компонент коректний — це гонка тесту.
**Очікувана поведінка:** тест стабільний незалежно від навантаження.
**Фактична поведінка:** падає під навантаженням, окремо проходить.
**Статус:** [x] виправлено — тест чекає сам виклик (`waitFor`), а «рівно один» перевіряє після
паузи; те саме в сусідньому кейсі «намір відразу PAID». П'ять прогонів під навантаженням — зелені.

## Bug #810 — [LOW] Property-тест рядків рахунку з наряду не генерував нульових кількостей і не перевіряв знак рядків

**Файл:** `apps/api/src/modules/invoices/invoices.work-order-lines.spec.ts:390`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:** властивість «Σ рядків = тотали наряду» брала кількість від 0,01 і ціну від 1,00 та
перевіряла лише суми. Дефект, який знайшов review (копійка округлення робила нульовий останній
рядок від'ємним), вона не могла зловити: ні нульових рядків, ні копійчаних цін, ні перевірки знака.
**Очікувана поведінка:** властивість покриває роботу з 0 фактичних годин і рядки, чий ПДВ
округлюється до нуля, і вимагає невід'ємності кожного рядка.
**Фактична поведінка:** цей клас входів не генерувався.
**Статус:** [x] виправлено — друга властивість: кількість 0 або 0,01–3,00, ціни 0,01–0,60 і
1–500, три режими, ставки 7/14/20; перевіряє три рівності й невід'ємність трьох сум рядка. Мутація
(копійка завжди в останній рядок) валить її на 14-му прикладі; 150 000 прогонів на поточному коді —
без контрприкладу.

## Session 2026-10-09 — Bug hunt `0846809c..HEAD` (рішення власника щодо ПДВ і оплат: живі перевірки округлення рядків, перерахунку при завершенні, часткової оплати, звітів і UI)

## Bug #811 — [MEDIUM] Модалка наряду: підсумок і суми рядків рахуються від сирих добутків і розходяться зі збереженими тоталами на копійку

**Файл:** `apps/web/src/components/ui/CreateWorkOrderModal.tsx:1511`, `apps/web/src/components/ui/work-order/WorksTable.tsx:176`, `apps/web/src/components/ui/work-order/PartsTable.tsx:160`
**Severity:** MEDIUM
**Категорія:** frontend

**Опис:** після BR-WO-007 сума наряду — це сума ОКРУГЛЕНИХ рядків, а модалка складала сирі добутки
`години × ціна` і округлювала раз (`total += h * p`). Суму окремого рядка таблиці друкували через
`(h * p).toFixed(2)`. Наживо, «ПДВ зверху»: наряд НРД-2026-001306 (0,3 × 111,11 ×3 і 0,7 × 199,99)
збережено як 239,98 / 48,00 / 287,98 — так показують список і сторінка наряду, а модалка показувала
«Сума без ПДВ 239,99 · Разом 287,99» при власному «Разом робіт 239.98». Рядок 0,3 × 100,05 у модалці
— «30.01», збережено 30,02 (НРД-2026-001305).
**Очікувана поведінка:** підсумок і рядки модалки збігаються зі збереженими тоталами до копійки.
**Фактична поведінка:** розбіжність у копійку на «незручних» кількостях.
**Статус:** [x] виправлено — `lineAmount()` у `lib/utils.ts` (те саме округлення, що `money()` на
бекенді) для суми рядка й для бази підсумку. Регресія: `utils.money.test.ts` (2 кейси) і
`CreateWorkOrderModal.vat-totals.test.tsx` (2 кейси, мутація валить обидва). Наживо після фіксу:
239,98 / 48,00 / 287,98 і «30.02».

## Bug #812 — [LOW] Дашборд: «завершено сьогодні» рахує за UTC-датою — наряди, закриті в перші години київської доби, не потрапляють

**Файл:** `apps/web/src/app/(app)/dashboard/page.tsx:202`
**Severity:** LOW
**Категорія:** frontend

**Опис:** лічильник порівнював `completedAt.slice(0, 10)` (UTC-дата ISO-рядка) з київським «сьогодні».
Наживо о 00:20 за Києвом 09.10: за ніч завершено 10 нарядів (`completedAt` = `2026-10-08T21:…Z`),
картка «В роботі» показувала «0 завершено сьогодні». Той самий клас, що Bug #808 у звіті «Виручка».
**Очікувана поведінка:** наряд, завершений сьогодні за Києвом, рахується в «завершено сьогодні».
**Фактична поведінка:** перші 2–3 години доби лічильник бачить учорашню дату.
**Статус:** [x] виправлено — `kyivDateOf()` у `lib/format.ts` (київська дата мітки часу), дашборд
порівнює її з `kyivToday()`. Регресія: `format.test.ts` (3 кейси, літній і зимовий час). Наживо
після фіксу лічильник показав завершені за ніч наряди.

## Bug #813 — [LOW] Авто-рядок наряду з огляду авто пише неокруглену суму: план і факт того самого рядка розходяться на копійку

**Файл:** `apps/api/src/modules/inspection/inspection.service.ts:136`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `amount = normoHours * price` ішов у `Decimal(12,2)` сирим. Для 0,3 × 100,05 це
30.014999…, Postgres зберігає 30,01, а тотали наряду (BR-WO-007) беруть той самий рядок як
`money(0,3 × 100,05)` = 30,02. Кошторис (план, з `amount`) і сума наряду (факт) розходились на
копійку при плані = факту; ручне додавання роботи (`addLine`) округлює через `money()`. З читання
коду, підтверджено модульним тестом; наживо не відтворювалось (потрібна робота довідника з такою
ціною, прив'язана до пункту огляду).
**Очікувана поведінка:** сума авто-рядка округлена тим самим правилом, що й у тоталах наряду.
**Фактична поведінка:** сирий добуток, округлення робить база.
**Статус:** [x] виправлено — `money(normoHours * price)`. Регресійний кейс у
`inspection.service.spec.ts` (мутація валить).

## Bug #814 — [LOW] Друкований наряд і рахунок із наряду читають рядки без сортування: порядок рядків у документі випадковий

**Файл:** `apps/api/src/modules/work-orders/work-orders.service.ts:1264`, `apps/api/src/modules/invoices/invoices.service.ts:916`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `generatePdf` наряду й `writeLinesFromWorkOrder` рахунку читали роботи й запчастини без
`orderBy`; екран, акт і кошторис читають за `createdAt`. Наживо три однакові наряди
(НРД-2026-001289…001291, рядки введено в одному порядку) надрукувались трьома різними порядками
робіт, а в рахунку РАХ-2026-002024 запчастини стояли навпаки, ніж у РАХ-2026-002025. Для рахунку
це ще й робило випадковим «останній рядок», який забирає копійку округлення (BR-INV-002).
**Очікувана поведінка:** рядки документа — у порядку введення, як на екрані.
**Фактична поведінка:** порядок визначає Postgres.
**Статус:** [x] виправлено — `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]` в обох читаннях.
Регресійні кейси у `work-orders.pdf-totals.spec.ts` і `invoices.create-from-work-order.spec.ts`
(мутація валить обидва). Наживо після фіксу PDF трьох нарядів — у порядку введення.

## Session 2026-10-09 — Bug hunt `a22ef4a5..HEAD` (цикл 1: пошук і відбір за датою на п'яти списках документів, вкладки банку, живі перевірки API проти SQL і UI в браузері)

Наживо: п'ять endpoint-ів звірено з незалежним SQL (пошук по кожному полю, регістр, `%` `_` `\`
буквально, довгий `q`, поєднання з фільтрами, межі дат, чужа організація) — розбіжностей у
відборі не знайдено. Три дефекти — на межі «поле вводу ↔ запит».

## Bug #815 — [MEDIUM] Поле дати лишає на екрані відхилену дату: показаний період не дорівнює застосованому

**Файл:** `apps/web/src/components/ui/date-picker-input.tsx:172`
**Severity:** MEDIUM
**Категорія:** frontend

**Опис:** `DatePickerInput` не передає батькові дату поза межами `min`/`max` і недописану дату —
але введений текст лишався в полі назавжди. У відборі «З / По» (`DateRangeFilter`: склад, оплати,
банк, каса) межі обмежують одна одну, тож сценарій буденний. Наживо на «Касі»: період
09.03–09.03, ввід «З 11.03» (пізніше за «По» — відхилено мовчки), потім «По 11.03» (прийнято).
Поля показували «11.03 – 11.03», запит пішов `dateFrom=2026-03-09&dateTo=2026-03-11`, у таблиці
8 операцій за три дні замість 2 за один. Те саме на «Оплатах» («По 01.10» при «З 07.10») і
«Складі». Каса і склад відкриваються з періодом «сьогодні – сьогодні», тому перший же ввід «не
тієї» межі першою дає розбіжність.
**Очікувана поведінка:** поле показує ту дату, що застосована у відборі.
**Фактична поведінка:** поле показує відхилений ввід, список — інший період.
**Статус:** [x] виправлено — `onBlur` повертає в поле застосоване значення (поки поле у фокусі,
введений текст видно). Регресійні кейси: `DatePickerInput.test.tsx` (3), `DateRangeFilter.test.tsx`
(сценарій каси); мутація (без `onBlur`) валить 3 з них. Наживо після фіксу: «З 11.03» повертається
до 09.03, вибір дня в календарі працює.

## Bug #816 — [LOW] Пошук довший за 100 символів: запит 400, у таблиці лишаються рядки попереднього пошуку

**Файл:** `apps/web/src/app/(app)/stock-documents/page.tsx:485`, `apps/web/src/app/(app)/bank-statements/BankTransactionsTab.tsx:152` (+ три інші поля пошуку)
**Severity:** LOW
**Категорія:** frontend

**Опис:** `GET /stock-documents` і `GET /bank-statements/transactions` відхиляють `q` довший за
100 символів (DTO `@MaxLength(100)`, 400 «Поле "q" занадто довге»); рухи, оплати й каса мовчки
обрізають до 100. Поля пошуку довжину не обмежували. Наживо на «Складі» й у «Банківських
платежах»: вставлено 150 символів → 400, а таблиця й далі показує 6 рядків попереднього пошуку
«TESTER-C1» — під новим текстом у полі.
**Очікувана поведінка:** поле не дає ввести більше, ніж бекенд шукає.
**Фактична поведінка:** 400 і застарілі рядки під новим текстом пошуку.
**Статус:** [x] виправлено — `maxLength={LIST_SEARCH_MAX_LENGTH}` (100, `lib/utils.ts`) на всіх
п'яти полях. Регресійний кейс у кожному з п'яти `*.filters.test.tsx`; мутація валить. Наживо:
у полі лишається 100 символів, 400 немає.

## Bug #817 — [LOW] `GET /stock-documents`: неіснуюча дата у відборі мовчки стає іншим днем, дата з часом у `dateTo` — безіменний 400

**Файл:** `apps/api/src/modules/stock-documents/stock-documents.dto.ts:188`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `dateFrom` / `dateTo` перевірялись нестрогим `@IsDateString()`. Наживо:
`dateFrom=2026-02-31` → 200 і відбір від 03.03 (JS перекочує дату), `dateTo=2026-02-31` → 200;
`dateFrom=2026-10-09T10:00:00Z` → 200, а той самий рядок у `dateTo` → 400 «Некоректні дані
запиту» від Prisma (сервіс дописує `T23:59:59.999Z`). Банк і каса такі значення вже відхиляють
іменованою помилкою.
**Очікувана поведінка:** приймається лише календарна дата `YYYY-MM-DD`; решта — 400 з назвою поля.
**Фактична поведінка:** відбір за іншим днем без помилки.
**Статус:** [x] виправлено — `@Matches(YMD_RE)` + `@IsDateString({ strict: true })`, як у
`ListQueryDto` банку. Регресійні кейси у `stock-documents.contract.spec.ts` (6); мутація валить 4.
Наживо після фіксу: `2026-02-31` → 400 «Поле "dateFrom" має бути коректною датою», порожнє
значення — як і раніше «без межі». Оплати й рухи складу лишаються з неперевіреною датою —
відоме питання, не чіпав.

---

## Session 2026-10-09 — Bug hunt `22904be8..HEAD` (цикл 3: дати в розрізах залишків, суми рядків через `lineAmount`, каса — живі перевірки API і UI в браузері)

Наживо: розрізи «за документами» / «за партіями» з коректними, порожніми, неіснуючими датами й
роком із 5 цифр; наряд НРД-2026-001382 із дробовими кількостями і рахунок РАХ-2026-002176 з нього
(суми рядків і тотали зійшлися); каса — пошук, дати, зміна каси. Один дефект — у перетворенні
київської доби на межі UTC.

## Bug #818 — [LOW] Набір дати в полі «з / по» розрізів залишків: кожна дата дає чотири відповіді 500

**Файл:** `apps/api/src/common/utils/kyiv-date.ts:37` (`kyivOffsetMs`), `:106` (`isCalendarDate`)
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `kyivOffsetMs` дізнається зсув поясу через рядок `toLocaleString('en-US')`. Для років
0–99 рік друкується без провідних нулів («10/9/2»), і `new Date` читає його як 2002: «зсув»
виходить близько 2000 років, межа доби йде в Prisma датою до нашої ери, Postgres відмовляє — 500.
Рідне поле дати (`InventoryTab`, «Звіти → Залишки → По документах / По партіях») віддає саме такі
значення, поки користувач набирає рік по цифрі: `0002-10-09`, `0020-10-09`, `0202-10-09`,
`2026-10-09`. Наживо в браузері: набір «09.10.2026» у полі «з» → `500 by-document?from=0002-10-09`
×2 (повтор React Query), `500 …from=0020-10-09` ×2, далі 200. Перевірка дати з циклу 2
(`assertCalendarDateQuery`) ці значення пропускає — вони календарні. Те саме на рівні API в рухах
складу (`GET /stock-items/movements`) і операціях каси (`GET /cash-registers/:id/operations`);
там поля власні й проміжних років не шлють. Окремо: рік `0000` і початок доби `0001-01-01`
(це 31.12 року 0 за UTC) давали 500 у всіх списках, оплати включно.
**Очікувана поведінка:** будь-яка календарна дата у відборі — 200 з коректними межами доби;
неіснуюча (рік 0000) — 400.
**Фактична поведінка:** 500 «Внутрішня помилка сервера» на звичайному наборі дати з клавіатури;
у журналі сервера — по чотири помилки на кожну набрану дату.
**Статус:** [x] виправлено — `kyivOffsetMs` для років 0–99 рахує зсув для тієї самої миті через
400 років (повний григоріанський цикл: той самий календар, той самий місцевий середній час);
межа доби не опускається нижче `0001-01-01T00:00:00Z`; `isCalendarDate` відхиляє рік `0000`.
Регресійні кейси в `kyiv-date.filters.spec.ts` (9 нових: у файлі 29 проти 20); три мутації валять відповідно 4, 1 і 2 кейси.
Наживо після фіксу: набір дати в обох полях обох розрізів — лише 200; `from=0001-01-01` → 200,
`from=0000-12-31` → 400 «Невірна дата у відборі».

---

## Session 2026-10-09 — Bug hunt `117e9f1e..HEAD` (київська доба в оплатах, звітах, зарплаті, календарі, акті звірки; спільне поле дати; смуга помилки списків — живі перевірки API проти SQL і UI в браузері)

## Bug #819 — [MEDIUM] Слот, що починається після кінця робочого дня, зберігається з кінцем раніше за початок

**Файл:** `apps/api/src/modules/calendar/calendar.service.ts:295`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `createSlot` ділить слот на межі робочого дня за умовою `endAt > workDayEnd`, не
дивлячись, де слот починається. Для слота, що починається ПІСЛЯ кінця робочого дня, «сьогоднішня»
частина виходить від'ємною. Наживо: `POST /calendar/slots` 23:30–23:50 за Києвом (25.10.2026, без
підйомника, робочий день 8–20) → 201 і два записи: батьківський `21:30Z → 18:00Z` (кінець на
3,5 год раніше за початок) і продовження наступного дня `06:00Z → 09:50Z` — 3 год 50 хв замість
запитаних 20 хв. Те саме на 29.03 і на звичайний день. На підйомнику такий слот дає від'ємні
години у звіті «Завантаженість» і займає чужий ранок наступного дня.
**Очікувана поведінка:** слот поза робочим часом зберігається одним записом із запитаним часом —
так само, як слот до відкриття (00:30–00:50 зберігається як є).
**Фактична поведінка:** запис із `endAt < startAt` плюс продовження хибної тривалості.
**Статус:** [x] виправлено — ділиться лише слот, що починається в робочий час
(`startAt < workDayEnd && endAt > workDayEnd`); правило BR-CAL-007 у дос'є календаря. Два кейси в
`calendar.service.spec.ts`; мутація (стара умова) валить обидва. Наживо після фіксу: 23:30–23:50
на 29.03, 25.10 і 09.10 → один слот, видно у своєму дні й не видно в наступному. У базі живих
слотів із `endAt < startAt` — 0 (три створені перевіркою видалено через API).

## Bug #820 — [LOW] П'ять списків документів: `dateFrom=0000-01-01` → 500, `2026-02-31` → відбір за 03.03

**Файл:** `apps/api/src/modules/work-orders/work-orders.dto.ts:265`, `invoices/invoices.dto.ts:225`, `purchase-orders/purchase-orders.dto.ts:267`, `supplier-returns/supplier-returns.dto.ts:160`, `supplier-payments/supplier-payments.dto.ts:187`
**Severity:** LOW
**Категорія:** typescript

**Опис:** `dateFrom` / `dateTo` у списках нарядів, рахунків, замовлень, повернень і оплат
постачальнику стояли під нестрогим `@IsDateString()`. Після переходу на `dateOnlyRangeFilter`
значення йде в `new Date(...)` як є: `0000-01-01` доходить до Postgres (року 0 немає) — 500 на
всіх п'яти списках; `2026-02-31` JS перекочує в 03.03 — 200 і список за іншим днем. Той самий клас,
що Bug #817 / #818, але ці п'ять DTO тоді не зачепили.
**Очікувана поведінка:** некалендарна дата — 400.
**Фактична поведінка:** 500 або мовчазний відбір за іншим днем.
**Статус:** [x] виправлено — `@Matches(CALENDAR_DATE_RE)` + `@IsDateString({ strict: true })` у
п'яти DTO. Новий спек `apps/api/src/common/utils/list-date-query-dto.spec.ts` (45 кейсів, по 9 на
DTO); мутація одного DTO валить 5 його кейсів. Наживо: `0000-01-01`, `2026-02-31`, `0001-01-01` →
400; порожні межі й звичайна дата → 200, `total` збігається з SELECT.

## Bug #821 — [LOW] Онлайн-запис: `date=0000-01-01` і `0001-01-01` → 500, `2026-02-31` → вільний час іншого дня; список заявок не перевіряє дату

**Файл:** `apps/api/src/modules/booking/booking.controller.ts:83`, `:127`; `apps/api/src/modules/booking/booking.service.ts:142`, `:430`
**Severity:** LOW
**Категорія:** typescript

**Опис:** публічний `GET /booking/availability` перевіряв лише форму дати (`\d{4}-\d{2}-\d{2}`):
рік 0000 і початок київської доби 0001-01-01 (31.12 року 0 за UTC) давали 500, а `2026-02-31` —
200 з вільним часом 03.03. `GET /booking?date=` (список заявок) дату не перевіряв узагалі.
Після переведення модуля на спільний `kyivOffsetMs` виправлення Bug #818 сюди дійшло лише
наполовину: зсув рахується, а нижньої межі `0001-01-01T00:00:00Z` немає.
**Очікувана поведінка:** некалендарна дата — 400; будь-яка календарна — 200.
**Фактична поведінка:** 500 на публічному endpoint.
**Статус:** [x] виправлено — `isCalendarDate` у `availability`, `assertCalendarDateQuery` у списку
заявок, нижня межа доби `EARLIEST_DB_INSTANT_MS` в обох запитах сервісу. Кейс у
`booking.service.spec.ts`. Наживо: `0000-01-01`, `2026-02-31`, `abc` → 400; `0001-01-01`,
`9999-12-31` → 200; `2026-10-12` → 10 вільних годин 08:00–17:00 за Києвом (і у віджеті в браузері).

## Bug #822 — [LOW] Акт звірки з початком періоду пізніше за кінець створюється (201)

**Файл:** `apps/api/src/modules/settlements/settlements-account.service.ts:117`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `POST /counterparties/:id/reconciliation-acts` з `periodFrom=2026-10-09`,
`periodTo=2026-10-01` відповідав 201 і зберігав акт без рядків, з `periodFrom > periodTo` і
закриваючим балансом «на 01.10». Звіти й зарплата на той самий ввід дають 400.
**Очікувана поведінка:** 400 «Дата початку має бути не пізніше дати закінчення», акт не створюється.
**Фактична поведінка:** 201, у базі лишається перевернутий акт.
**Статус:** [x] виправлено — перевірка порядку меж до читань бази. Два кейси в
`settlements.reconciliation-act.spec.ts`. Наживо: перевернутий період → 400; акт за один день
(225 рядків) і за 01–09.10 (866 рядків) — рядки й сума збігаються з SELECT за київською добою.
Один перевернутий акт, створений перевіркою до фіксу, лишився в базі (акти не видаляються).

## Bug #823 — [LOW] «Звіти → Залишки», режим «По товарах»: збій завантаження показує «нічого не знайдено» і не дає повторити

**Файл:** `apps/web/src/app/(app)/inventory/InventoryTab.tsx:252`, `:407`
**Severity:** LOW
**Категорія:** frontend

**Опис:** смугу `ListLoadError` отримали лише розрізи «По документах» / «По партіях». У режимі «По
товарах» (типовий) відмова `GET /stock-items` показувала звичайний банер без кнопки повтору, а під
ним — порожній стан «товарів не знайдено», ніби склад порожній. Наживо: перехоплена відповідь 500
→ банер + порожній стан; після відновлення сервера екран лишався таким до перезавантаження.
**Очікувана поведінка:** смуга з текстом помилки і «Повторити», порожній стан прихований.
**Фактична поведінка:** порожній стан поруч із помилкою, повторити нічим.
**Статус:** [x] виправлено — `ListLoadError` з `refetch` для списку товарів, порожній стан не
рендериться за помилки. Два кейси в `InventoryTab.dates.test.tsx`. Наживо: 500 → смуга, 0 рядків,
без «не знайдено»; «Повторити» → 22 рядки, смуга зникла.

## Bug #824 — [LOW] Зарплата: смуга помилки розрахунку без «Повторити», кнопка «Розрахувати» вдруге нічого не робить

**Файл:** `apps/web/src/app/(app)/payroll/page.tsx:312`
**Severity:** LOW
**Категорія:** frontend

**Опис:** `ListLoadError` на сторінці зарплати стояв без `onRetry`. «Розрахувати» лише вмикає
запит (`setPreviewEnabled(true)`), тож після збою повторне натискання нічого не шле. Повторити
розрахунок із тими самими датами можна було тільки змінивши дату туди й назад.
**Очікувана поведінка:** смуга з «Повторити», як на касі, оплатах, банку й рухах.
**Фактична поведінка:** текст помилки без дії.
**Статус:** [x] виправлено — `onRetry={() => void preview.refetch()}`. Кейс у
`PayrollListPage.test.tsx`. Наживо: 500 → смуга з «Повторити»; після відновлення клік → таблиця
розрахунку й кнопка «Створити період».

---

## Session 2026-10-09 — вихідні банківські платежі: bug hunt наживо (імпорт файлом, краї ручного внесення)

Діапазон: `4298581c..73327fc2`. Наживо через API (`127.0.0.1:3000`) і web (`:3001`), дані з позначкою
`TESTER-OUT`. Файли імпорту згенеровано в scratch (CSV, XLSX через ExcelJS).

## Bug #825 — [MEDIUM] Імпорт виписки: рядок із сумою менше копійки блокує ВЕСЬ імпорт, суми не округлюються до копійок

**Файл:** `apps/api/src/modules/bank-statements/bank-statement-parser.service.ts:194`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `resolveAmount` віддає суму як є: `-0,005` → `0.005`, числова комірка XLSX `0.1+0.2` →
`0.30000000000000004`, `-7,129` → `7.129`. Прев'ю показує такий рядок, а `import/apply` має
`@Min(0.01)` на кожен рядок — один рядок `0.005` дає 400 «Поле "rows.2.amount" менше за допустимий
мінімум» на весь запит, і виписку з цього файла імпортувати неможливо взагалі (майстер не дає
викинути рядок). Суми з хвостом проходять і округлюються вже базою, а `amountBase` рахується з
неокругленої.
**Очікувана поведінка:** сума рядка — у копійках; рядок, що округлюється до нуля, пропускається
(BR-BANK-017: «рядок із нульовою сумою не імпортується»).
**Фактична поведінка:** прев'ю 9 рядків → `apply` 400, жоден рядок не імпортовано.
**Статус:** [x] виправлено — `resolveAmount` округлює суму до копійок (`roundMoney`), нуль після округлення — пропуск; у режимі двох колонок теж. 7 кейсів у `bank-statement-parser.service.spec.ts`. Наживо: `-0,005` → 0.01, `-7,129` → 7.13, `apply` 201.

## Bug #826 — [MEDIUM] Імпорт виписки: списання у форматі «(150,00)», «−200,00», «150,00 грн», «1.234,56» мовчки зникають

**Файл:** `apps/api/src/modules/bank-statements/bank-statement-parser.service.ts:328`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `parseNumber` розуміє лише `1 250,00` і `-150.5`. Бухгалтерський запис від'ємної суми в
дужках, типографський мінус (U+2212 — саме його ставить Excel у текстових експортах), сума з
позначкою валюти і сума з роздільниками тисяч і копійок разом (`1.234,56`, `1,234.56`) дають
`null`, і рядок пропускається як «заголовок». Після появи вихідних платежів це саме рядки списань:
у прев'ю їх просто немає, лічильника пропущених майстер не показує.
**Очікувана поведінка:** ці формати розбираються; `(150,00)` і `−200,00` — від'ємні (OUT у режимі SIGN).
**Фактична поведінка:** з 18 рядків файла у прев'ю 9; п'ять грошових рядків зникли без сліду.
**Статус:** [x] виправлено — `parseNumber` розбирає дужки, типографський мінус, позначку валюти і обидва роздільники (останній — десятковий); нерозбірне, як і раніше, `null`. 21 кейс у `bank-statement-parser.service.spec.ts`. Наживо: усі п'ять форматів у прев'ю з правильним напрямом.

## Bug #827 — [MEDIUM] Імпорт виписки: CSV з роздільником «;» не читається (400)

**Файл:** `apps/api/src/modules/bank-statements/bank-statement-parser.service.ts:212`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `parseCsvGrid` викликає `csv-parse` з типовим роздільником `,`. CSV українських банків і
Excel з українською локаллю розділяють колонки `;` (кома зайнята копійками). Такий файл із полями в
лапках дає 400 «не вдалося прочитати файл» ще на першому кроці майстра; без лапок — одну колонку,
розрізану по комах сум.
**Очікувана поведінка:** роздільник (`,` / `;` / табуляція) визначається з файла.
**Фактична поведінка:** `raw-preview` → 400.
**Статус:** [x] виправлено — `detectCsvDelimiter`: `,` / `;` / табуляція — якого більше поза лапками в перших 20 рядках. 6 кейсів у `bank-statement-parser.service.spec.ts`. Наживо: файл із `;` → 5 колонок, прев'ю те саме, що й з комою.

## Bug #828 — [MEDIUM] Сума ≥ 10 000 000 000 у ручному внесенні та `import/apply` → 500

**Файл:** `apps/api/src/modules/bank-statements/bank-statement.dto.ts:197`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:** `amount` у `CreateBankTransactionDto` і `ApplyRowDto` має лише `@Min(0.01)`. Колонка —
`Decimal(12,2)`: `1e10` доходить до бази і падає з `numeric field overflow` (Prisma P2020) →
«Внутрішня помилка сервера». У формі ручного внесення це одна зайва цифра в полі суми.
**Очікувана поведінка:** 400 із назвою поля.
**Фактична поведінка:** 500 на `POST /bank-statements/transactions` і `POST /bank-statements/import/apply`.
**Статус:** [x] виправлено — `@Max(BANK_TX_AMOUNT_MAX)` (9 999 999 999,99) на `amount` обох DTO. 2 кейси в `bank-statement.dto.spec.ts`. Наживо: 400 «Поле "amount" більше за допустимий максимум» на обох маршрутах. Лишилось: валютний рахунок, де сума проходить, а її еквівалент у базовій валюті — ні (понад 240 млн USD), досі дає 500.

## Bug #829 — [LOW] Ручне внесення: IBAN з пробілами відхиляється як «занадто довгий»

**Файл:** `apps/api/src/modules/bank-statements/bank-statement.dto.ts:290`
**Severity:** LOW
**Категорія:** business-logic

**Опис:** `payerIban` перевіряється `@MaxLength(34)` ДО нормалізації, а сервіс нормалізує IBAN
(UPPERCASE, без пробілів — BR-BANK-006) вже після. IBAN, скопійований із платіжки групами по
чотири (`UA90 3052 9929 9000 4149 1234 5678 9` — 36 символів), дає 400 «Поле "payerIban" занадто
довге», хоча сам IBAN — 29 символів.
**Очікувана поведінка:** пробіли прибираються до перевірки довжини.
**Фактична поведінка:** 400.
**Статус:** [x] виправлено — `@Transform(normalizeIbanInput)` перед `@MaxLength(34)`. 2 кейси в `bank-statement.dto.spec.ts`. Наживо: `ua90 3052 …` → 201, збережено `UA903052992990004149123456789`.
