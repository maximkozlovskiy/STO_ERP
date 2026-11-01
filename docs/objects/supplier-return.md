# SupplierReturn — Dossier

> Повернення товару постачальнику: документ «ПВП-…» на склад і постачальника, рядки — товар,
> кількість, ціна. Проведення списує товар зі складу і зменшує наш борг перед постачальником.
> Окремої сторінки немає: вкладка «Повернення» сторінки «Купівлі» (`/purchase-orders?tab=returns`).
> Дос'є складене з коду й тестів 2026-11-01 (TECH-DEBT §8 L528(11)); правила BR-SRET виведені з
> `supplier-returns.service.ts` і наявних спеків, нових рішень власника тут немає.

---

## Prisma модель

`packages/database/prisma/schema/07_inventory.prisma`:

```prisma
model SupplierReturn {
  id              String               @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String               @db.Uuid
  supplierId      String               @db.Uuid
  warehouseId     String               @db.Uuid
  purchaseOrderId String?              @db.Uuid  // замовлення-джерело, необов'язкове
  number          String
  status          SupplierReturnStatus @default(DRAFT)
  totalAmount     Decimal              @default(0) @db.Decimal(12, 2)
  notes           String?
  documentDate    DateTime             @default(now()) @db.Date
  syncVersion     BigInt               @default(0)
  createdAt       DateTime             @default(now())
  updatedAt       DateTime             @updatedAt
  deletedAt       DateTime?
}

model SupplierReturnLine {
  id               String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String    @db.Uuid
  supplierReturnId String    @db.Uuid
  goodId           String    @db.Uuid
  quantity         Float
  price            Decimal   @db.Decimal(12, 2)
  unitOfMeasureId  String?   @db.Uuid
  syncVersion      BigInt    @default(0)
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  deletedAt        DateTime?
}

enum SupplierReturnStatus { DRAFT CONFIRMED CANCELLED }
```

**Відносини:**

- → `Counterparty` (M:1 через `supplierId`), → `Warehouse` (M:1 через `warehouseId`)
- → `PurchaseOrder?` (M:1 через `purchaseOrderId`)
- ← `SupplierReturnLine[]` (1:M); рядок → `Good`, → `UnitOfMeasure?` (`SupplierReturnLineUoM`)

Номер — `DocumentNumberService.next(orgId, 'SUPPLIER_RETURN')` (формат — `DocumentNumberConfig`,
вкладка «Нумерація» налаштувань). Унікальність `(orgId, number)` серед невидалених — частковий
індекс у міграції `20260909210000` (Prisma його не виражає). Валюти в документі немає.

---

## FSM

```
DRAFT → CONFIRMED
      ↘ CANCELLED
```

Карта — `SR_TRANSITIONS` у `supplier-returns.service.ts`; `CONFIRMED` і `CANCELLED` — фінальні.

| Перехід                       | Side-effects                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| створення (`DRAFT`)           | подія `CREATED` (BR-AUT-060) у транзакції створення                                                                                                                                           |
| `DRAFT → CONFIRMED` (confirm) | CAS статусу, подія `STATUS_CHANGED`; на кожен рядок — рух `WRITEOFF` (`InventoryService.createMovement`); `SUPPLIER_REFUND` на суму документа (`SettlementsService`) — усе в одній транзакції |
| `DRAFT → CANCELLED` (cancel)  | CAS статусу, подія `STATUS_CHANGED`; рухів складу й боргу немає (нічого ще не списано)                                                                                                        |

---

## API Endpoints

Контролер `supplier-returns.controller.ts`, `JwtAuthGuard` + `RolesGuard`. Тіла створення й правки
валідує `ZodValidationPipe` спільними схемами `supplierReturnCreateSchema` /
`supplierReturnUpdateSchema` (`packages/shared/src/schemas/forms/supplier-return.schema.ts`).

| Метод  | URL                                          | Що                                                                                                  | Ролі                                  |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| POST   | `/api/supplier-returns`                      | створити чернетку (з рядками; `purchaseOrderId` — лише тут)                                         | OWNER, ADMIN, STOREKEEPER             |
| GET    | `/api/supplier-returns`                      | список: `page`, `limit`, `status`, `q` (номер або постачальник), `showDeleted`, `dateFrom`/`dateTo` | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT |
| POST   | `/api/supplier-returns/linked-counts`        | лічильники «Пов'язаних документів» для сторінки списку (`ids` 1…500)                                | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT |
| POST   | `/api/supplier-returns/:id/confirm`          | провести (BR-SRET-001…005)                                                                          | OWNER, ADMIN, STOREKEEPER             |
| POST   | `/api/supplier-returns/:id/cancel`           | скасувати чернетку                                                                                  | OWNER, ADMIN, STOREKEEPER             |
| GET    | `/api/supplier-returns/:id/lines-summary`    | зведення по табличних частинах (BR-WO-009 у `work-order.md`)                                        | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT |
| GET    | `/api/supplier-returns/:id/linked-documents` | замовлення-джерело, постачальник, склад (BR-SRET-010)                                               | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT |
| GET    | `/api/supplier-returns/:id`                  | картка; `?withDeleted=true` — перегляд видаленого (BR-WO-012)                                       | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT |
| PATCH  | `/api/supplier-returns/:id`                  | правка чернетки; `lines` — повна заміна рядків                                                      | OWNER, ADMIN, STOREKEEPER             |
| DELETE | `/api/supplier-returns/:id`                  | м'яке видалення чернетки, 204                                                                       | OWNER, ADMIN, STOREKEEPER             |

Підмаршрути оголошено перед `:id` (порядок маршрутів Fastify — стереже `contract.spec`).
Відповідь — `SupplierReturnResponseDto` (`supplierName`, `warehouseName`, `purchaseOrderNumber`,
`linesCount`, `deletedAt`, рядки з `amount = money(кількість × ціна)` і `unitShortName`).

Поза модулем повернення читають: «Пов'язані документи» контрагента (`counterparties.service.ts`,
секція `supplierReturns`), акт звірки (`settlements-account.service.ts` — номер документа),
автоматизація (`automation-context.service.ts`, тип документа `SUPPLIER_RETURN`; відкладене
повідомлення перевіряє скасування — `sms.processor.ts`, реєстр `automation.md`).

---

## UI (Web)

| Компонент / сторінка  | Файл                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Список (вкладка)      | `app/(app)/purchase-orders/page.tsx` — вкладка `returns`, `useListPage('supplier-returns')` |
| Картка / створення    | `components/ui/SupplierReturnCreateModal.tsx` (провести, скасувати, перегляд видаленого)    |
| Hook (TanStack Query) | `hooks/api/useSupplierReturns.ts`                                                           |
| Detail Panel schema   | `lib/panel-schema.ts` → `SUPPLIER_RETURN_PANEL_SCHEMA`                                      |
| «Пов'язані документи» | `lib/linked-configs.tsx` → `supplierReturnLinkedConfig`                                     |
| Перехід до повернення | `lib/linked-nav.ts` → `toSupplierReturn` (`/purchase-orders?openReturn=<id>`)               |

Web-тести: `components/ui/__tests__/SupplierReturnCreateModal.test.tsx`,
`SupplierReturnCreateModal.error-visible.test.tsx`, `SupplierReturnDirtyGuard.test.tsx`,
`app/(app)/purchase-orders/__tests__/PurchaseOrdersPage.returns-panel.test.tsx`.
E2E: `apps/web/e2e/supplier-returns.spec.ts` — вкладка й кнопка створення, повернення через API
з'являється в таблиці, `DRAFT → CONFIRMED`.

---

## Бізнес-правила (BR-SRET)

Правило про повтори товару окремими рядками і послідовне проведення — **BR-PO-008**
(`purchase-order.md`); постачальник — контрагент із роллю постачальника — **BR-CP-001**; перегляд
видаленого документа — **BR-WO-012**; відбір списку за календарною датою — **BR-PAY-018**.

- **BR-SRET-001**: **Статуси.** `DRAFT → CONFIRMED` (провести) або `DRAFT → CANCELLED`
  (скасувати); `CONFIRMED` і `CANCELLED` — фінальні. Перехід з фінального статусу — 400 ще до
  транзакції, без рухів і боргу. Скасування чернетки не створює рухів складу й операцій боргу.
- **BR-SRET-002**: **Проведення списує товар.** На кожен живий рядок — рух `WRITEOFF` через
  `InventoryService.createMovement` на склад документа: від'ємна кількість рядка, ціна й одиниця
  рядка, `documentType: 'SupplierReturn'`, `documentId` повернення. Нестача — відмова цілком
  (транзакція відкочується; сума по товару — BR-PO-008).
- **BR-SRET-003**: **Проведення зменшує борг перед постачальником.** Одна операція
  `SUPPLIER_REFUND` (знак +1, `docs/BUSINESS-RULES.md`) на суму документа через
  `SettlementsService.createTransaction`, у тій самій транзакції, без валюти (базова). Не `REFUND`
  (−1 — збільшив би борг) і не `PAYMENT` / `CHARGE`. Сума 0 — операції немає, списання є.
- **BR-SRET-004**: **Без рядків не проводиться.** Повернення без живих рядків — 400 до
  транзакції: ні руху, ні боргу, статус не змінено.
- **BR-SRET-005**: **Статус змінюється порівнянням-із-заміною.** Проведення першим записом у
  транзакції ставить `CONFIRMED` умовою `status = DRAFT`; рядки читаються лише після виграшу —
  два одночасні проведення не дають подвійного списання й боргу (програш — 400). Скасування пише
  `CANCELLED` умовою на прочитаний статус — проведення між читанням і записом не перетирається.
- **BR-SRET-006**: **Правка й видалення — лише чернетки.** `PATCH` і `DELETE` іншого статусу — 400.
  Видалення м'яке (`deletedAt` шапки); видалений документ не змінюється (404 — BR-WO-012).
- **BR-SRET-007**: **Посилання — лише своєї організації й невидалені.** Постачальник і склад —
  інакше 404; товари й одиниці рядків (`validateLineRefs`, при створенні й правці з рядками) —
  інакше 404 з першим відсутнім id; замовлення-джерело — інакше 400. Перевірка — до запису.
- **BR-SRET-008**: **Замовлення-джерело задається лише при створенні.** Схема правки його не
  містить, `update` не пише `purchaseOrderId` — зв'язок із замовленням зберігається.
- **BR-SRET-009**: **Сума документа = сума рядків, кожен округлений окремо**
  (`sumMoney(money(кількість × ціна))`, Bug #777 / #778): на дробових кількостях `totalAmount`
  дорівнює сумі `amount` рядків у відповіді. Правка перераховує суму з живих рядків.
- **BR-SRET-010**: **«Пов'язані документи»** — замовлення-джерело, постачальник, склад, лише живі
  й своєї організації; лічильник списку рахує те саме, що показує панель (видалені замовлення,
  постачальник чи склад — 0). Чуже або неіснуюче повернення — порожні секції без помилки;
  видалене (перегляд) — секції заповнені.
- **BR-SRET-011**: **Рядків у документі — не більше 500** (`ArrayMaxSize(500)` у
  `CreateSupplierReturnDto` / `UpdateSupplierReturnDto`, текст `err.dto.supplierReturn.lines.max`).
- **BR-SRET-012**: **Ролі.** Створення, правка, проведення, скасування, видалення — OWNER, ADMIN,
  STOREKEEPER; читання (список, картка, лічильники, пов'язані, зведення) — ще й ACCOUNTANT.
- **BR-SRET-013**: **Дата документа** — календарна (`@db.Date`); без дати при створенні —
  сьогодні за Києвом (`kyivToday`).

---

## Аспекти і тести, що їх стережуть

**Модуль:** `apps/api/src/modules/supplier-returns/`

**Маршрути UI:** `/purchase-orders`

```bash
cd apps/api && npx vitest run src/modules/supplier-returns/
```

| Аспект                                                                                                                                                                                   | Тест                                           | Кейсів |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| проведення й скасування: статуси, `WRITEOFF` з від'ємною кількістю, `SUPPLIER_REFUND`, сума 0, без рядків, CAS, тайм-аут за рядками, межі org посилань (BR-SRET-001…005, 007; BR-PO-008) | `supplier-returns.confirm-fsm.spec.ts`         | 19     |
| HTTP-контракт: форма списку, 403 без JWT, тіло створення, UUID, порядок підмаршрутів, `linked-counts` (1…500 UUID), ролі зведення, `withDeleted` (BR-WO-009, BR-WO-012)                  | `supplier-returns.contract.spec.ts`            | 26     |
| повтори товару окремими рядками: правка, порядок рядків, рухи по одному, достатність за сумою по товару (BR-PO-008)                                                                      | `supplier-returns.duplicate-lines.spec.ts`     | 7      |
| «Пов'язані документи» й лічильники: живі цілі, межі org, видалене повернення (BR-SRET-010, BR-WO-012)                                                                                    | `supplier-returns.linked-docs.spec.ts`         | 7      |
| список: відбір за датою документа календарними межами, tenant-фільтр (BR-PAY-018)                                                                                                        | `supplier-returns.list-date-filter.spec.ts`    | 4      |
| замовлення-джерело при створенні, роль постачальника при створенні й правці, правка не чіпає замовлення (BR-SRET-007, 008; BR-CP-001)                                                    | `supplier-returns.purchase-order-link.spec.ts` | 7      |
| сума документа = сума рядків на дробових кількостях (BR-SRET-009)                                                                                                                        | `supplier-returns.totals.spec.ts`              | 1      |
| документ, позначений на видалення: лише перегляд, жодна зміна (BR-WO-012)                                                                                                                | `supplier-returns.with-deleted.spec.ts`        | 10     |

Разом: **81** кейс (цифри з `vitest --reporter=json`, не з grep).

Подію автоматизації в транзакції створення, проведення й скасування стереже тест-перепис
`automation/record-document-event.census.spec.ts` (BR-AUT-060, реєстр `automation.md`).

**Розходження з кодом.**

- **BR-SRET-011** — межа 500 рядків стоїть лише в DTO-класах, а контролер валідує тіло
  zod-схемою (`ZodValidationPipe(supplierReturnCreateSchema)`), де масив `lines` межі не має; тип
  параметра — псевдонім типу, тож глобальний `ValidationPipe` клас DTO не застосовує. Рядки ж
  читаються з `take: MAX_QUERY_LIMIT` (1000): за кодом документ із понад 1000 рядків при проведенні
  спише лише перші 1000, а борг зменшить на повну суму, порахувану при створенні з усіх рядків.
  Наживо не відтворено. Рішення (межа в zod-схемі, як у DTO) — за власником.

**Чого тут НЕМА.**

- BR-SRET-006 — тесту, що `PATCH` / `DELETE` проведеного чи скасованого повернення дає 400, немає:
  спеки перевіряють лише видалений документ (404, `with-deleted.spec.ts`). `remove` позначає
  видаленою лише шапку: рядки лишаються з `deletedAt = null`.
- BR-SRET-012 — ролі маршрутів змін unit-тестом не перевіряються: `contract.spec.ts` звіряє лише
  ролі зведення з ролями списку (BR-WO-009); що бухгалтер не може провести чи змінити повернення,
  не стереже жоден тест.
- BR-SRET-013 — підстановку `kyivToday()` замість відсутньої дати жоден тест не перевіряє.
- Сторно проведеного повернення немає: `CONFIRMED` фінальний, повернути товар на склад і борг
  назад можна лише іншим документом. Валюти в поверненні немає — борг зменшується в базовій
  валюті, навіть коли замовлення-джерело в іншій.
- Друкованої форми повернення немає (TECH-DEBT §8 L785).
- Integration-спеку (`*.integration.spec.ts`) немає: справжню гонку двох проведень у PostgreSQL
  і відкат транзакції при нестачі моделюють моки.
- Назва кейсу `confirm(): settlement transaction створюється з type=REFUND` застаріла: тест
  перевіряє `SUPPLIER_REFUND`. Не перейменовано, бо назви входять у baseline гейта A.
