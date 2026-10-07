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
