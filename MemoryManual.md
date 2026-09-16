# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-09-17
Фаза:       Аудит #1 ЗАВЕРШЕНО — усі 6 форм-модалок (Good/Employee/Counterparty/Vehicle/Invoice + 4 документи
            Ф4 + WorkOrder Ф5) на zod+RHF зі спільними схемами. QA-ланцюг sync→review→tester пройдено по кожній фазі.
TypeScript: ✅ 0 errors (shared + api + web, tsc --noEmit --incremental false)
Тести:      api 2479/2479 (161 файл) · web 343/343 · CreateWorkOrderModal 13/13 · work-order-schema.spec 17/17 ·
            work-orders module 131/131.
HEAD:       9968a39f docs(skills): RHF+.uuid() fixture-trap test-authoring approach → sto-tester
Tester:     2026-09-17 (auto, Фаза 5) — 0 продакшн-багів; shim-міграція без регресій у 9 зонах ризику
            (SHIM цілісність, гроші/idempotency Bug #755 retry-dedup runtime-підтверджено, UA-кома гейт,
            nullable clear, status-conditional PATCH, actualHours recalc, calendar-sync, dirty-guard, stock-totals).
            +2 runtime-guard тести (retry-dedup + double-submit через реальний RHF shim), +skill test-authoring
            патерн (RHF+.uuid() placeholder-фікстури тихо блокують submit) (8a55bf62/9968a39f).
Review:     2026-09-17 (auto, Фаза 5, коміт d8a569aa) — 1 Important виправлено: WorkOrder FORM-схема
            (workOrderFormSchema, гейт submit через safeParse(getValues())) валідувала числові поля
            через numericString/z.coerce.number (Number('1,5')=NaN) → легітимний UA-ввід «1,5» у
            quantity/normoHours/price/plannedHours/actualHours мовчки блокував submit хибним zod-issue,
            хоча локальні add-гейти (toNumberOrUndefined, comma-aware) кому приймали. Fix: новий
            optionalMoneyNumber() + moneyString у FORM-схемі (endpoint-схеми без змін — payload numeric
            JSON). SHIM-архітектура (form/setForm/lines/parts як watch()/setValue/replace bridge, Bug #755
            retry-dedup, nullable clear-семантика, RHF isDirty bridge, canEdit/canEditActual) — звірено
            чисто, регресій немає. Новий патерн → sto-review §8.2 + Накопичені підходи (eb667b51).
Sync:       2026-09-17 (Фаза 5, коміти cd4b58c0/a61f990a) — 1 баг знайдено й виправлено: save() header PATCH
            слав `undefined` (omit) замість `null` (очистити) коли користувач очищав "Підйомник" (Select →
            "— Без підйомника —") або datetime-local "Плановий початок/кінець". workOrderUpdateSchema.liftId/
            plannedAt/dueDate явно nullable (null очищає, undefined лишає) — сервіс так само розрізняє, але
            форма не мала способу виразити "очистив" через існуючий `|| undefined`/localDateTimeToISO('')
            (обидва повертають undefined на порожньому вводі). Fix: liftId → `|| null`; plannedAt/dueDate →
            fallback (form.plannedStartAt ? undefined : null), що відрізняє "не чіпали" від "очистили". Решта
            звірено чисто: header/line/part zod-схеми ↔ DTO field-by-field (validation-parity @Min/@IsEnum/
            @IsUUID/@IsISO8601 збігається), WORK_ORDER_PRIORITY/REPAIR_CATEGORY_VALUES = Prisma enum точно,
            multi-request архітектура (header POST /work-orders, lines/parts окремими /lines /parts) — фронт
            шле саме туди, shim-payload (form.*/toNumberOrUndefined comma-aware) відповідає бек-очікуванням,
            useWorkOrders interface ↔ WorkOrderResponseDto/Line/Part DTO — усі поля збігаються.
Prev HEAD:  50567fd8 fix(tester): Bug #756 — стабілізація flaky DocumentCreateModals (RHF-модалки) timeout:2000
Tester:     2026-09-17 (auto, Фаза 4) — 0 продакшн-багів. Ручний аудит усіх 4 модалок: useFieldArray
            identity/mutation (PO editingKey=field.id, commitEdit/update/remove/append коректні, display-поля
            збережені), гроші/idempotency (moneyString UA-кома, lines у $transaction, savingRef, createdIdRef),
            dirty-guard (Bug #639), edit-load reset()→clean, cross-field (sourceType↔account, TRANSFER),
            PO складні флоу (receive/pricing/Excel/multicurrency) — усе чисто. Єдиний фікс Bug #756 (LOW,
            лише тест): DocumentCreateModals flaky під паралельним suite (async-flush starvation важких
            RHF-модалок) → explicit timeout:2000 на всі async-асерти; продакшн НЕ чіпано.
Review:     2026-09-17 (auto, Фаза 4, коміт cf7de79c) — 1 Important + 2 Suggestion виправлено:
            (I) PurchaseOrderCreateModal handleCreate/handleSave показували хардкод «Оберіть постачальника
            та склад» на будь-який safeParse-фейл; кнопка вже гарантує supplier+warehouse → реальний фейл
            майже завжди у рядку (порожня ціна/кількість) → оманливе повідомлення. Fix: firstSchemaError()
            бере перший zod-issue.message зі схеми (усі українські) + префікс «Рядок N:» для line-items;
            тип zod-error без прямого import zod (web не має його прямою залежністю). (S) мертвий import
            POLine у PO (лишок RHF-міграції). (S) allowedTransitions у StockDoc загорнуто в useMemo (як у PO)
            — referential stability + усунено exhaustive-deps warning. sto-dev/sto-review оновлено новим
            патерном (safeParse misleading-error §8.2). Решта Фази 4 чиста: isDirty-міст (markDirty/resetDirty
            else-гілка не конфліктує з save-flow), усі auto-select {shouldDirty:false} (Bug #639), useFieldArray
            identity (editingKey=field.id, update/remove/append за index, display-поля через cast), WEB-H3
            savingRef синхронний у всіх 4 (handleSubmit ставить ref СИНХРОННО на вході onValid до першого await;
            PO через safeParse-хендлери), createdIdRef retry-safety (SupplierPayment) збережена, Controller
            field.value {}-cast + exactOptionalPropertyTypes ok, ukrainian errors + h-8 alignment. Контролери
            4 модулів чисті (guards/roles/ParseUUIDPipe). Sync-агент пройшов чисто ПЕРЕД review (0 розбіжностей).
Prev HEAD:  675d6b4c fix(sync): invoiceType 'INVOICE' поза UI-enum ламав редагування рахунків з наряду
Sync:       2026-09-16 (Фаза 3, коміти 6157d9fe/107daec7) — 1 баг знайдено й виправлено: createFromWorkOrder
            (основний шлях створення рахунку) не ставив invoiceType → Prisma @default("INVOICE"), яке поза
            UI-enum STANDARD/PREPAYMENT/CREDIT_NOTE. При редагуванні такого рахунку reset() писав 'INVOICE'
            у форму (?? 'STANDARD' не спрацьовує — truthy), zodResolver валив submit. Fix: normalizeInvoiceType()
            у InvoiceCreateModal (будь-яке значення поза enum → 'STANDARD' при завантаженні) + бек тепер явно
            ставить invoiceType='STANDARD' і у createFromWorkOrder, і у ручному create()-дефолті. Решта
            звірено синхронно: header POST/PATCH окремо від lines POST/DELETE, validation-parity dueDate/
            documentDate/amount/quantity/unitPrice/vatRate = class-validator DTO (декоративні після
            ZodValidationPipe-міграції, але типи звірені), useFieldArray _key/id локальні (не у payload),
            retry-safety (createdInvoiceRef/initialLineIdsRef) збережена.
Prev HEAD:  b003d98a fix(review): прибрано мертвий import hasCounterpartyName у CounterpartyEditModal
Review:     2026-09-16 (auto, коміти ab169ab0..9905f947 Counterparty+Vehicle zod+RHF+enum-канонізація) — 1 Suggestion виправлено:
            осиротілий import hasCounterpartyName у CounterpartyEditModal (name-by-type тепер лише
            через zodResolver counterpartyFormSchema.superRefine). Решта чисто: update-схема partial()
            без superRefine — merged name-by-type робить сервіс (counterparties.service:315-322 ефективний
            post-PATCH type); vehicle customerGarageId optional у формі / required у vehicleCreateSchema,
            обидва create-консюмери гарантують гараж (query або garage auto-create), update дропає гараж;
            optionLabel fallback на raw value (fuel/transmission/drive/body = String?, НЕ Prisma enum →
            міграція без ADD VALUE, VAN досяжний, unmapped лишається raw); два незалежні useForm у модалці
            не конфліктують; savingRef WEB-H3, currentCpIdRef tenant-guard, rhfDirty→useDirtyForm міст
            (з else — vehicle-tab має власний save-flow) — усе коректне; прибрані validateCounterpartyForm/
            formToPatch + локальні vehicle enum-константи (2 сторінки) без осиротілих імпортів. tester
            рекомендовано (архіт. зміна + DB-міграція + вкладені модалки). Prev review нижче:
Review-prev1: 2026-09-16 (auto, коміт eb3582cb Employee zod+RHF) — 1 Suggestion (латентний) виправлено:
            percent/ratePerHour/fixedMonthly/bonusPercent = numericString() (обовʼязкове z.number())
            → ПОРОЖНЄ будь-яке (навіть приховане неактивне за rateType) → NaN → не-локалізоване
            "Expected number, received nan" блокувало сабміт. Fix: flatRateNumber() (number|NaN),
            фінітність АКТИВНОГО поля гейтить superRefine з локалізованим меседжем. +2 регрес-тести.
            Решта чисто: superRefine діапазони коректні (percent 1..100, ratePerHour>=0, bonus 0..100),
            grantAccess→loginEmail+password+minlen, useForm<Input,_,Values> коерсить числа, rhfDirty→
            markDirty БЕЗ else (не тре assignment-dirty, reset не вмикає dirty), rateSchemeSchema
            реекспорт без циклів, Controller PhoneInput/DatePicker value/onChange коректні,
            ZodValidationPipe дзеркалить 400-контракт. Prev review нижче:
Review-prev: 2026-09-16 (auto, коміт 46fab8c9 raw-preview) — 1 Suggestion виправлено:
            cellText для формули з result-об'єктом ({result:{error}}) давав «[object Object]»
            → тепер result рекурсується через cellText; гілку 'error' піднято перед 'result'.
            +тест (#DIV/0!). Решта чисто: RBAC OWNER/ADMIN/XLSX_MANAGER на endpoint, БД/orgId
            не чіпає, limit clamp 1..100, totalRows=actualRowCount, 1-based row.values, XSS
            неможливий (React екранує cells/title), тиха деградація onError, reset rawPreview
            при виборі/відкритті, tabular-nums, множина рядок/рядків, sticky шапка+перший стовпець.
Prev:       d91fe897 (auto) — generic Excel-import FRONTEND: 2 Important
            виправлено. (1) handlePreview/handleApply мали лише disabled={isPending} без
            синх-guard → подвійний клік у одному тіку = дубль preview/apply (Bug #630 клас);
            (2) savedMapping-effect затирав введені колонки при react-query refetch →
            mappingAppliedRef (раз за відкриття). Решта чисто: onClose стабільний (useCallback
            у батьках), cache invalidation коректний (PO/SD keys за docType + mapping detail),
            FormData не шле порожні колонки, apply-payload = whitelist DTO (0 зайвих полів).
            web tsc 0, 15/15 модалок зелені.
            Попередній BACKEND review (HEAD f509cd8b): 0 проблем.
```

**Backlog тех-боргу (усе 🟢):** TD1 currencyId NOT NULL + seed base-валюти; TD2 schema-integrity
guard + self-heal trgm проти db push; TD3 консолідація (pagination/kyiv-date utils, DTO-мапери,
4 скіли стиснуто, декомпозиції CreateWorkOrderModal + PurchaseOrderCreateModal, sto-tester split).

**3 QA-цикли (sto-sync→review→tester→optimize→e2e→simplify→code-review→security-review):**
знайдено+виправлено ~30 issue (найвагоміше — цикл-3 code-review зловив, що optimize-RTT-фікс
`updateSaved` порушив A1 tenant-guard → feature dead-on-arrival, виправлено `where:{id,orgId,
deletedAt:null}` + перевірено наживо). 0 security-вразливостей у всіх 3 циклах. Нові фічі, дороблені
у циклах: XLSX-import UI, pricing apply-all, maintenance-schedule edit, expense-category restore,
saved-report rename. Спільний `lib/download.ts` helper. Відкладено: Bug #747 (WorkOrder-модалка не
закривається на dirty-on-open, передіснуючий, test.fixme + BUG_REPORT).

---

## Останній commit

```
Аудит #1 Фаза 5 — WorkOrder на zod+RHF (найскладніша, ЗАВЕРШУЄ аудит #1) — 2026-09-17, HEAD 9968a39f:
  <бек> work-order.schema (header/line/part + form) + 6 endpoint-ів (create/update, lines POST/PATCH,
        parts POST/PATCH) → ZodValidationPipe. Nullable-семантика update. FIX (spec): nullable() з
        z.coerce.number() коерсив null→0 → plannedHours:null тихо ставив 0; fix z.union([z.null(),inner]).
  a61f990a <фронт> CreateWorkOrderModal RHF+useFieldArray через SHIM (form/lines/parts = watch()-відбиток;
        setter-и diff getValues()+setValue/replace) → money-логіка (~700р) byte-for-byte. Bug #755 retry-dedup
        (postedLineKeysRef/postedPartKeysRef). Архітектура як Invoice (header тіло, lines/parts окремі endpoint).
  252af5fc <sync> save() слав undefined замість null для liftId/plannedAt/dueDate → clear мовчки не зберігався.
  d8a569aa <review> FORM-схема відхиляла UA-кому '1,5' (numericString→NaN) → safeParse-гейт блокував submit;
        fix optionalMoneyNumber()/moneyString у form-схемах (endpoint не чіпано). ⚠️ Той самий кома-клас
        латентний у Invoice/PO/StockDoc/SupplierReturn FORM-схемах (PO parseFloat('1,5')=1 тихе усічення) —
        поза scope Ф5, кандидат на наступний фікс.
  8a55bf62 <tester> 0 багів; +2 runtime-guard тести (retry-dedup + double-submit через RHF shim).
tsc shared+api+web 0. api 2479/2479, web 343/343, work-order-schema 17/17, WO module 131/131.

Аудит #1 Фаза 4 — 4 документ-модалки на zod+RHF зі спільними схемами — 2026-09-17, HEAD 50567fd8:
  eb063aaa SupplierPayment: supplier-payment.schema (sourceType↔account superRefine, moneyString()
           UA-кома), controller ZodValidationPipe, RHF-модалка +dirty-guard (нового не було).
  6f863a95 StockDocument: stock-document.schema (TRANSFER superRefine Bug #462), RHF+useFieldArray
           (lines у тілі $transaction, без окремого /lines-endpoint).
  89d9ff98 SupplierReturn: supplier-return.schema (price required, purchaseOrderId create-only),
           RHF+useFieldArray з INLINE-редагуванням рядків (register(lines.N.quantity)), unitOfMeasureId.
  40c6cec8 PurchaseOrder (найскладніша, 1981р): purchase-order.schema (contractId/trackingNumber
           nullable update), RHF+useFieldArray; receive/Excel/pricing/multicurrency/create-then-edit
           збережено. FIX (review): inline-edit editingKey=field.id (не line._key) — edit-row інакше
           не активувалась (жоден тест не ганяв inline-edit → спіймано у review перед комітом).
  cf7de79c review-фікс: firstSchemaError() у PO (змістовна line-item помилка замість хардкоду) +
           allowedTransitions у StockDoc у useMemo. 50567fd8 tester Bug #756 (flaky test → timeout:2000).
  Патерн MP-F6/MP-F6.1: спільна zod-схема = ЄДИНЕ джерело валідації web↔api (ZodValidationPipe на беку +
  zodResolver на фронті). Усі рядки-документи (StockDoc/SR/PO) шлють lines У ТІЛІ (атомарно), на відміну
  від Invoice (окремий /lines-endpoint + retry). QA: sync чисто → review 3 фікси → tester 0 продакшн-багів.
tsc shared+api+web 0. api 2462/2462, web 793/793, 4 schema-специ 38/38.

Аудит #1 Фаза 1 — Employee на zod + react-hook-form — 2026-09-16, HEAD 2f974834:
  eb3582cb feat(forms): Employee на zod + RHF — employeeFormSchema (superRefine крос-польові),
           rateSchemeSchema перенесено у @sto/shared (реекспорт з api dto), numericString()
           валідатор, controller create/update через ZodValidationPipe, EmployeeEditModal на
           RHF+zodResolver (Controller для PhoneInput/DatePickerInput, міст rhfDirty→markDirty).
  2f974834 review-фікс: flatRateNumber() — приховані неактивні числові поля (за rateType) не
           блокують сабміт не-локалізованим NaN-меседжем; фінітність активного поля у superRefine.
tsc shared+api+web 0. employee-schema 15/15, employees 27/27, EmployeeEditModal 4/4.

Generic Excel-імпорт товарів (FRONTEND) — 2026-09-15, HEAD d91fe897 (3 коміти):
  b913ab48 useExcelImport хуки (preview multipart / apply JSON / counterparty mapping GET+PUT)
           + ExcelImportWizard.tsx (generic ui/, 2-крокова модалка matched/ambiguous/notFound)
  03a098c9 підключення майстра до PurchaseOrderCreateModal + StockDocumentCreateModal
           («Завантажити з Excel» поряд з XlsxImportButton, стабільний onClose)
  d91fe897 review-фікс: синх double-submit guard (handlePreview/handleApply) + once-per-open
           застосування savedMapping (mappingAppliedRef проти react-query refetch-clobber)
web tsc 0 (--incremental false — фантомна PricingRulesClient обходиться), 15/15 модалок зелені.

Generic Excel-імпорт товарів (BACKEND) — 2026-09-15, HEAD 5f3ae56c (3 feature-коміти):
  a4e93da8 normalizeArticle util + skuNormalized/normalizedSynonym SOT + resolveByNameOrSynonym
  228ebadb xlsx adapter registry (PO/SD) + previewImport/applyImport + DTO + controller (DI-drift #724)
  5f3ae56c CounterpartyImportMapping module (GET/PUT /counterparties/:id/import-mapping)
DB-крок був окремим комітом 44e17aba (schema). tsc 0, 297+288 тестів зелені.
Деталі → CHANGELOG.md.
```

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                                     | Що                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/download.ts`                                                           | `downloadBlob`/`downloadUrl` — SOT браузер-завантаження (attached anchor + deferred revoke) |
| `apps/api/src/common/utils/pagination.ts`                                                | `calculatePagination` (NaN-guard + cap)                                                     |
| `apps/api/src/common/utils/kyiv-date.ts`                                                 | Kyiv-date утиліти (DST-aware)                                                               |
| `apps/api/src/prisma/schema-integrity.integration.spec.ts`                               | TD2 guard: manual-SQL конструкти (partial-unique/trgm/EXCLUDE/CHECK) живі у БД              |
| `apps/api/src/modules/work-orders/work-order-dto.mapper.ts`                              | Винесені WorkOrder DTO-мапери (cost-price role-mask)                                        |
| `apps/web/src/components/ui/work-order/{InvoiceConflictDialog,PlannedActualMetrics}.tsx` | Виділені суб-компоненти CreateWorkOrderModal                                                |
| `apps/web/src/components/ui/purchase-order/{types,RulePricerModal}.tsx`                  | Виділені з PurchaseOrderCreateModal                                                         |
| `.claude/skills/sto-tester/sto-tester-approaches.md`                                     | Журнал патернів багів (винесено зі SKILL.md)                                                |
| `apps/api/src/common/utils/normalize-article.ts`                                         | `normalizeArticle` — upper + strip non-alnum (SOT skuNormalized/normalizedSynonym)          |
| `apps/api/src/modules/xlsx/document-line-import.adapter.ts`                              | Generic import: PO/StockDocument адаптери + registry (loadDoc/assertDraft/replaceLines)     |
| `apps/api/src/modules/xlsx/import.dto.ts`                                                | PreviewImportDto (multipart) + ApplyImportDto (@ArrayMaxSize 1000)                          |
| `apps/api/src/modules/counterparty-import-mappings/`                                     | Персист мапінгу колонок Excel per-контрагент (GET/PUT, upsert по @unique)                   |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- Generic Excel-імпорт: `XlsxService.previewImport/applyImport` + `DocumentLineImportAdapterRegistry`
  (docType→adapter). skuNormalized/normalizedSynonym пишуться ЛИШЕ у Goods/BrandsService (SOT).
  XlsxService конструктор: Prisma+Pricing+**Goods+Brands+registry** (DI-drift #724 — оновлювати всі специ)
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (з FX_GAIN:+1/FX_LOSS:−1)
- Мультивалюта: money-рядки carry amount+currencyId+amountBase+rateUsed; баланс/звіти у base;
  `requireBaseCurrencyId` fail-closed у WO/Invoice/PO create; currencyId NOT NULL на 4 документних таблицях
- `Promise.all` для per-line writes у SD transition/PO receive (disjoint rows — safe)
- work-orders.service.ts parts loops — **sequential** (shared StockItem composite key — unsafe to parallelize)
- **A1 tenant-guard** ($extends fail-closed): кожен guarded Prisma-виклик МУСИТЬ нести orgId/branchId
  у where (інакше TenantIsolationError) — і для update({where:{id,orgId}}), не лише findMany
- CalendarSlot.parentSlotId — split-day continuation invariant (не колапсувати через updateMany)
- BullMQ API: `@Processor('queue', { concurrency: N })` + `extends WorkerHost` + `async process(job: Job<T>)`
- SMS-канал через `NotificationsService.send(orgId, eventType, payload)` — НЕ прямий `smsQueue.add()`
- **NestJS SWC на Windows**: залишити tsc builder (`nest start --watch` без `--builder swc`)
- **`rootDir: "src"` у api tsconfig** — обов'язково (інакше dist/apps/api/src/main.js → MODULE_NOT_FOUND)
- **tsc web incremental cache** ламається → використовувати `npx tsc --noEmit --incremental false`
  (голий tsc дає фантомну PricingRulesClient-помилку)

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі, Prisma моделі, утиліти, sync                                                    |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField + Мета-патерни MP-B1..B10/MP-F1..F5          |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                                  |
| [docs/GOTCHAS.md](docs/GOTCHAS.md)                   | Відомі пастки — читати перед новою фічею                                                    |
| [docs/GAPS.md](docs/GAPS.md)                         | Реєстр прогалин/ризиків (G1-G15 бізнес, TD1-TD3 тех-борг)                                   |
| [CHANGELOG.md](CHANGELOG.md)                         | Журнал комітів по фічах                                                                     |
| [BUG_REPORT.md](BUG_REPORT.md)                       | Відкриті/закриті баги (#747 відкритий)                                                      |
| [docs/objects/](docs/objects/)                       | Дос'є агрегатів: WO, Invoice, PO, StockDoc, Counterparty, Good, Work, Calendar, Settlements |
| [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md) | User preferences                                                                            |

---

## Правило оновлення (для агентів)

Після кожного коміту — оновити **тільки** цей файл:

1. `Останній commit` → нові хеші (5–6 рядків, ЗАМІНИТИ старі, не додавати)
2. `Поточний стан` → TypeScript статус, дата, тести
3. `Нові файли/утиліти` → якщо з'явились нові
4. `Активні особливості` → якщо щось змінилось у логіці

**НЕ** додавати сюди деталі рішень, full bug descriptions, список виправлень (файл має лишатись
~150 рядків). Деталі → `CHANGELOG.md` (append, 3–5 рядків max per commit).
Патерн/правило → відповідний довідник (одне місце правди).
