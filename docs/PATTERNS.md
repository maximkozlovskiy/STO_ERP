# PATTERNS — STO ERP

> UI/UX компоненти, Design System, стійкі патерни кодування.
> Читати перед написанням нових сторінок або компонентів.

---

## Ключові компоненти (apps/web/src/components/ui/)

| Компонент                           | Файл                       | Що робить                                                       |
| ----------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `Modal`                             | `modal.tsx`                | `useId()` per instance, AnimatedBody, Escape, focus trap        |
| `AnimatedBody`                      | `modal.tsx` (export)       | ResizeObserver + height transition 260ms                        |
| `ModalTabs`                         | `modal-tabs.tsx`           | Вкладки для 1→N (Авто, Наряди, Штрихкоди)                       |
| `DetailPanel`                       | `detail-panel.tsx`         | Бокова панель з tabs, configFields (⚙), PanelField/PanelSection |
| `DetailPanelToggle`                 | `detail-panel-toggle.tsx`  | Кнопка поруч з ColumnsDropdown                                  |
| `PhoneInput`                        | `phone-input.tsx`          | Маска `+38 (0XX) XXX-XX-XX`                                     |
| `DirtyConfirmDialog`                | `dirty-confirm-dialog.tsx` | Діалог підтвердження закриття                                   |
| `TabBar`                            | `TabBar.tsx`               | Taskbar для згорнутих модалок (amber chips)                     |
| `BulkActionsBar`                    | `BulkActionsBar.tsx`       | Панель bulk-actions з Promise.allSettled                        |
| `InlineEditCell` / `InlineViewCell` | —                          | Inline editing у таблиці                                        |

---

## Hooks (apps/web/src/hooks/)

| Hook                   | Файл                      | Що робить                                                                    |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `useDetailPanel`       | `useDetailPanel.ts`       | localStorage toggle для бокової панелі                                       |
| `useDetailPanelConfig` | `useDetailPanelConfig.ts` | Offline-first конфіг полів (localStorage + API)                              |
| `useDirtyForm`         | `useDirtyForm.ts`         | `confirmClose(): Promise<boolean>`                                           |
| `useBulkSelect`        | `useBulkSelect.ts`        | Множинний вибір, auto-prune stale IDs                                        |
| `useInlineEdit`        | `useInlineEdit.ts`        | Inline editing з savingRef race guard                                        |
| `useSavedFilters`      | `useSavedFilters.ts`      | Пресети фільтрів в localStorage                                              |
| `useUiFeatures`        | `useUiFeatures.ts`        | 10 UX-прапорців, module-level cache + TTL                                    |
| `useConflictCheck`     | `useConflictCheck.ts`     | Conflict probe для calendar slots                                            |
| `useTabBar`            | `useTabBar.ts`            | activateTab/closeTab                                                         |
| `useNavConfig`         | `useNavConfig.ts`         | Per-user кастомізація sidebar (user-preferences `nav_layout` + localStorage) |

### Патерн: per-user overlay-resolver поверх статичних дефолтів

Коли треба дозволити користувачу кастомізувати статичний конфіг (порядок/приховані/групування), НЕ
мутуючи дефолт: тримай **дефолт як єдине джерело** (напр. `MASTER_NAV_ITEMS`), а per-user зміни — як
тонкий **overlay** (`NavLayout`: order/hidden/custom-groups/moves), і застосовуй чистою функцією
`resolve(master, overlay, ...)`. Взірець — `lib/nav-layout.ts` (`resolveNav`). **Ключове правило —
FAIL-SAFE:** будь-який дефолтний елемент, відсутній в overlay, ЗАВЖДИ зʼявляється (нові пункти після
апдейту застосунку не губляться) — overlay лише перевпорядковує/ховає, ніколи не є whitelist-ом.
Зберігати через `useDetailPanelConfig`-патерн (user-preferences generic key/value + localStorage-кеш).
Безпекові фільтри (roles) застосовуй у resolver-і завжди — overlay не має обходити доступ.

### API Hooks (apps/web/src/hooks/api/) — вже мігровані на TanStack Query

`useWorkOrders`, `useCounterparties`, `useInvoices`, `useInventory`, `usePurchaseOrders`, `useEmployees`, `useBookingRequests`, `usePricingRules`, `useStockDocuments`, `useInfrastructure`, `useReports`, `useSyncStatus`, `useDashboardData`, `useWorks`

---

## Патерн: List Page (еталон: work-orders/page.tsx)

```tsx
// 1. TanStack Query
const { data, isLoading } = useWorkOrders(filters);

// 2. Фільтри — module-level frozen const
const TYPE_FILTERS = Object.freeze(['', ...Object.keys(LABELS)]);

// 3. Bulk select
const bulkSelect = useBulkSelect(data?.items ?? []);

// 4. Inline edit
const inlineEdit = useInlineEdit({ enabled: features.inlineEditEnabled, onSave });

// 5. Detail panel
const detailPanel = useDetailPanel('page-key');

// 6. Saved filters
const { saved, save, remove } = useSavedFilters<Filters>('page-key');
```

---

## Патерн: CreateModal (еталон: CreateWorkOrderModal.tsx)

- **lines у body** POST /resource (не POST /resource/:id/lines)
- **initialLineIdsRef** snapshot при відкритті edit-mode → DELETE для removed lines
- **toNumberOrUndefined()** нормалізує кому→крапку
- **close-guard**: `onClose={saving ? () => {} : onClose}`
- **Retry-safety**: `createdRefId` зберігає id після POST, до рядків
- **disabled**: умовний (`saving || !required || (TRANSFER && !targetWarehouseId)`)

---

## Патерн: Modal+ModalTabs для 1→N (§14 sto-dev)

```tsx
// State-блоки на кожну колекцію:
const [modalItems, setModalItems] = useState<Item[]>([]);
const [modalItemsLoading, setModalItemsLoading] = useState(false);
const [itemsError, setItemsError] = useState<string | null>(null);
const modalItemsReqRef = useRef(0);

// Race guard:
const openEdit = async item => {
  const reqId = ++modalItemsReqRef.current;
  setModalItemsLoading(true);
  apiFetch(`/items?parentId=${item.id}`)
    .then(d => {
      if (reqId === modalItemsReqRef.current) setModalItems(d.items);
    })
    .catch(e => {
      if (reqId === modalItemsReqRef.current) setItemsError(e.message);
    })
    .finally(() => {
      if (reqId === modalItemsReqRef.current) setModalItemsLoading(false);
    });
};

// При відкритті скидати:
setModalItems([]);
setItemsError(null);
setModalGarageId(null); // скинути залежний стан
```

---

## Патерн: Detail Panel з конфігуратором

```tsx
// page.tsx
const config = useDetailPanelConfig('crm');

<DetailPanel
  configFields={[
    { fieldKey: 'phone', label: 'Телефон' },
    { fieldKey: 'balance', label: 'Баланс' },
  ]}
  onToggleField={config.toggleField}
  onReset={config.reset}
  tabs={selectedItem ? buildPanelFields(selectedItem, config) : undefined}
/>;
```

Поля НІКОЛИ не хардкодяться — схема у `lib/panel-schema.ts` + `buildPanelFields()`.

---

## Патерн: Settings Tab (§26 sto-dev)

```tsx
// Snapshot при завантаженні
const initialRef = useRef({ recalc: false, sync: false });

// PATCH тільки змінені поля
const patch = {};
if (form.recalc !== initialRef.current.recalc) patch.recalcPlannedHoursFromLines = form.recalc;
if (form.sync !== initialRef.current.sync) patch.syncCalendarSlotWithPlannedHours = form.sync;
if (Object.keys(patch).length === 0) {
  toast.info('Змін немає');
  return;
}

// Toggle (не checkbox) для boolean налаштувань
<Toggle checked={form.recalc} onChange={v => setForm(f => ({ ...f, recalc: v }))} />;
```

---

## Патерн: TanStack Query Key factory

```typescript
export const workOrdersKeys = {
  all: ['work-orders'] as const,
  list: (f: Filters) => [...workOrdersKeys.all, 'list', f] as const,
  detail: (id: string) => [...workOrdersKeys.all, 'detail', id] as const,
};

// usePaginatedList ОБОВ'ЯЗКОВО:
queryKey: [key, 'list', filters]; // НЕ [key, filters]

// TopShell prefetch — ПОВНИЙ initial filter object:
queryKey: workOrdersKeys.list({
  page: 1,
  limit: 20,
  status: '',
  q: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
});
```

---

## Патерн: apiFetch vs apiMultipartFetch

```typescript
// ✅ JSON (default):
const data = await apiFetch<WorkOrder[]>('/work-orders');

// ✅ File upload (FormData):
await apiMultipartFetch('/xlsx/import', formData);
// ❌ НЕ apiFetch з body: FormData → 406 "not multipart"
```

---

## Патерн: Ref-cache для довідників

```typescript
// Consumer page (не CRUD-source):
const cached = getCached<Branch[]>('cache:branches');
if (cached?.length) setBranches(cached);
apiFetch<Branch[]>('/branches').then(d => {
  setBranches(d);
  setCache('cache:branches', d);
});
```

---

## Патерн: BulkActions з Promise.allSettled

```typescript
const bulkActions: BulkAction[] = [
  {
    id: 'cancel',
    label: 'Скасувати',
    variant: 'destructive',
    onClick: async ids => {
      const results = await Promise.allSettled(
        ids.map(id =>
          apiFetch(`/resource/${id}/transition`, {
            method: 'POST',
            body: JSON.stringify({ status: 'CANCELLED' }),
          }),
        ),
      );
      const ok = results.filter(r => r.status === 'fulfilled').length;
      bulkSelect.clear();
      load();
      if (features.toastEnabled) {
        if (ok === ids.length) toast.success(`Скасовано ${ok}`);
        else toast.warning(`Скасовано ${ok} з ${ids.length}`);
      }
    },
  },
];
```

---

## Патерн: TabBar (TaskBar для згорнутих модалок)

- `TabBarContext` + `useTabBar` → `activateTab/closeTab`
- `minimizeModal(modalKey, label, restoreProps)` — dedupe по (modalKey + identity-keys)
- `setPendingRestore(tab)` → TopShell useEffect → `setRestoredWoOpen(true)`
- `dynamic(() => import(...), { ssr: false })` — запобігає circular module init

---

## Design System (Tailwind 4 canonical tokens)

```
bg-surface          bg-surface-hover      bg-surface-raised
text-primary        text-secondary        text-muted
border-border
ring-ring
text-destructive    bg-destructive
text-primary-foreground  bg-primary
```

Заборонено: arbitrary values (`w-[37px]`, `text-[#333]`), raw colors (`bg-gray-100`), pixel magic.

---

## UX Feature Flags (useUiFeatures)

```typescript
const features = useUiFeatures(); // module-level cache + TTL

features.toastEnabled; // Toast після мутацій
features.unsavedGuardEnabled; // useDirtyForm
features.bulkActionsEnabled; // BulkActionsBar
features.savedFiltersEnabled; // useSavedFilters
features.inlineEditEnabled; // useInlineEdit
features.stockIndicatorEnabled; // К-т на складі
features.commandPaletteEnabled; // Ctrl+K
features.keyboardShortcutsEnabled;
features.syncIndicatorEnabled;
features.notificationCenterEnabled;
```

**Правило:** `if (features.toastEnabled) toast.success(...)` — НЕ напряму без прапорця.

---

## Pricing Hierarchy (calculateSalePrice)

1. `goodId` — конкретний товар
2. `brandId` — бренд
3. `goodCategory` — категорія
4. `goodType` — тип (SPARE_PART/CONSUMABLE/...)
5. all (null scope) — загальне правило

COST_TIER: знайти тір де `costMin <= costPrice < costMax`; `costMax IS NULL` = останній тір.

---

## Universal Patterns (B1-B7 + C)

**B1 — SharedStatusConstants** (`packages/shared/src/constants/statuses.ts`):

- `WO_STATUS_LABELS/BADGE/TRANSITIONS`, `WO_PRIORITY_*`, `WO_CATEGORY_LABELS`
- `INVOICE_STATUS_*`, `INVOICE_TYPE_LABELS`
- `PO_STATUS_*`, `PO_STATUS_ACTION_LABELS`
- `STOCK_DOC_STATUS_*`, `STOCK_DOC_TYPE_*`
- `EMPLOYEE_STATUS_*`, `EMPLOYEE_ROLE_*`
- Re-exported від `@sto/shared`. Всі 7 сторінок мігровані.

**B2 — usePaginatedList** (`apps/web/src/hooks/api/usePaginatedList.ts`):

- `buildParams` пропускає `null/undefined/''/false` значення, без trailing `?` для пустих params
- Всі 5 list hooks делегують findAll до `usePaginatedList`

**B3 — useListPage** (`apps/web/src/hooks/useListPage.ts`): composable для list сторінок — pagination + bulkSelect + tableColumns + detailPanel + panelConfig + savedFilters

**B4 — FSMButtons** (`apps/web/src/components/ui/fsm-buttons.tsx`): shared FSM transition кнопки, `size: 'sm' | 'md'` (НЕ 'default' — Button uses xs/sm/md/lg/icon)

**B5 — useApiMutation** (`apps/web/src/hooks/useApiMutation.ts`): unified mutation wrapper з toast+error+saving state

**B6 — Shared Zod validators** (`packages/shared/src/schemas/validators.ts`): `phoneUaSchema`, `emailSchema`, `ibanUaSchema`, `uuidFieldSchema`, `positiveNumberSchema`, `nonNegativeNumberSchema`. Увага: не конфліктувати з `uuidSchema` у `schemas.ts`

**B7 — useApiError** (`apps/web/src/hooks/useApiError.ts`): `useApiError(initial?)` + `parseApiError(e: unknown): string`

**C — Schema-driven audit** (`apps/web/src/lib/panel-schema.ts`):

- `COUNTERPARTY_PANEL_SCHEMA`, `EMPLOYEE_PANEL_SCHEMA`
- `schemaToPanelConfigFields(schema)` → `buildPanelFields(item, config)` з renderOverrides
- Поля НІКОЛИ не хардкодяться: схема → авторендер

---

## Патерн: EntityPickerField

Будь-яке поле форми що посилається на інший об'єкт — через `EntityPickerField`:

```tsx
// Layout: [ display text    × 🔍 … ]  (кнопки всередині поля)
<EntityPickerField
  display={form.counterpartyDisplay}
  placeholder="Обрати контрагента..."
  onOpenDetail={form.counterpartyId ? openCpDetail : undefined} // undefined = disabled
  onPick={() => setCpPickerOpen(true)}
  onClear={() => setForm(f => ({ ...f, counterpartyId: '', counterpartyDisplay: '' }))}
/>
// + SearchPickerModal для вибору зі списку
// + *EditModal відкривається через лупу (lazy fetch перед відкриттям)
```

### Правила EntityPickerField

- `onOpenDetail = undefined` → кнопка 🔍 disabled (об'єкт не обраний)
- lazy fetch у `openDetail()` — НЕ у useEffect при mount
- `onSaved` оновлює `display` у батьківській формі
- Кнопка "Створити новий" — ЗОВНІ поля, праворуч
- Paired-state reset: якщо picker змінює supplier → скидати залежні поля (contractId тощо)

### Реєстр \*EditModal компонентів

| Компонент                  | Для об'єкта                                            |
| -------------------------- | ------------------------------------------------------ |
| `CounterpartyEditModal`    | контрагент (tabs: main/vehicles/contracts/work-orders) |
| `GoodEditModal`            | товар (tabs: info/barcodes/batches)                    |
| `EmployeeEditModal`        | співробітник (tabs: main/zones/lifts/categories)       |
| `WorkOrderAddLineModal`    | додавання роботи до наряду                             |
| `WorkOrderAddPartModal`    | додавання запчастини до наряду                         |
| `PurchaseOrderCreateModal` | замовлення постачальнику                               |
| `InvoiceCreateModal`       | рахунок                                                |
| `StockDocumentCreateModal` | документ складу                                        |

---

# Мета-патерни (наскрізні архітектурні принципи)

> Не «де файл», а «ЧОМУ так писати». Кожен підкріплений реальним багом, який виникав при
> порушенні. Формат: **суть → еталон file:line → який КЛАС багів ловить → grep-детектор**.

## BACKEND

### MP-B1. Single-source-of-truth для знаку/константи-осі

Доменна вісь (знак, мапа міток) визначається ОДИН раз, `export`-ується; споживачі імпортують,
а не дублюють inline. Фронт-дзеркала явно позначаються коментарем «дзеркалить …».

- **Еталон:** `settlements.service.ts:25` `export const BALANCE_SIGN: Record<...>`; переюз у
  `settlements-account.service.ts:133` (reconciliation act) замість власного CASE.
- **Сімейство:** `*_SORT_FIELDS` (module-level allow-list у кожному findAll: PO/SP/INV/WO/SD),
  FSM-осі `work-orders.fsm.ts:16-52` (`CLOSED_STATUSES`/`STATUS_LABELS`, «Mirrors @sto/shared»).
- **Клас багів:** розсинхрон осі — та сама цифра фарбується різними кольорами / знак балансу
  різниться між списком і карткою (Bug #606 — 5 копій осі знаку balance).
- **Детектор:** `type ==?= 'CHARGE'|'PAYMENT'`, inline `balance > 0 ?` поза utils/settlements;
  локальний `const BALANCE...` замість import.

### MP-B2. Централізація мутацій через ЄДИНУ точку

Інваріантні мутації — ЛИШЕ через один метод; побічні ефекти вбудовані ВСЕРЕДИНІ, не поряд.

- **Еталони (CLAUDE.md):** залишки → `InventoryService.createMovement` (партійне списання
  вбудоване туди ж, після `stockItem.upsert`, у тій самій tx); баланс →
  `SettlementsService.createTransaction`; FSM → `WorkOrdersService.transition`.
- **Клас багів:** «мертвий код» — метод написаний, протестований, але не викликається з
  централізованої точки → залишок/баланс розходиться з журналом (партійне списання
  `consumeBatch` — 0 викликів до 2026-09-02).
- **Детектор:** прямі `prisma.stockItem.update(`, `settlementAccount.update(`,
  `workOrder.update({...status`, `.delete(` поза відповідним service.

### MP-B3. Tenant isolation (orgId) + soft-delete скрізь

Кожен запит фільтрується `orgId`; `deletedAt: null` за замовчуванням; restore — atomic
`updateMany({ NOT: { deletedAt: null } })`; mutation-update перевіряє `result.count === 0`.

- **Еталони:** `counterparties.service.ts:361` (restore-atomic, «еталон brands»),
  `settings.service.ts` (updateMany з `count===0` guard).
- **Клас багів:** Bug #607 — reports не фільтрував soft-deleted CP → видалені у звіті + 404 на deep-link.
- **Детектор:** `findMany`/`findFirst` без `orgId`; `.update({ where: { id }` (без orgId); `prisma.X.delete(`.

### MP-B4. Async tenant-guard після await

Після кожного `await` у handler звіряємо live-id (ref) / captured `idAtStart` ПЕРЕД `setState`
(фронт) або cross-tenant guard (бек) — інакше stale-response потрапляє в чужий контекст.

- **Еталон:** `CounterpartyEditModal.tsx` `cpIdAtStart` + `currentCpIdRef`; бек-дзеркало —
  `inventory.service.ts:87` UoM-guard («FK enforces global existence, not orgId»).
- **Клас багів:** race при швидкому перемиканні — відповідь на старий fetch перезаписує новий контекст.
- **Детектор:** `await apiFetch` → `setState` без `if (...Ref.current !== ...AtStart) return`.

### MP-B5. Configuration over Hardcode

Параметри з БД (`OrganisationSettings`/`BranchSettings`), не magic numbers; читання через
`SettingsService.get*` (Redis-кеш + offline-fallback через try/catch).

- **Еталон:** `inventory.service.ts:resolveCostMethod` → `getOrganisationSettings`, `?? 'FIFO'`;
  `settings.service.ts:32` (cache-key, TTL, catch при Redis-down = offline-first).
- **Клас багів:** захардкоджений costMethod/dueDays ігнорує налаштування org (перемикач «Метод
  списання партій» був у UI, але код його не читав).
- **Детектор:** числові літерали `invoiceDueDays`/`slotDurationMinutes`; `'FIFO'`/`'AVG_COST'`
  захардкоджені поза resolveCostMethod.

### MP-B6. Cross-field валідація на ВСІХ entry-points

Guard на беку (canonical) + ІДЕНТИЧНИЙ guard на КОЖНІЙ frontend-точці, що б'є в endpoint;
дзеркало має ту саму семантику (`.trim()`).

- **Еталон:** `counterparties.service.ts:hasCounterpartyName` (create + update-merged); фронт-дзеркала
  CounterpartyEditModal + CalendarSlotModal (обидва з `.trim()`).
- **Клас багів:** другий entry-point без дзеркала шле невалідний payload / guard без trim пропускає whitespace.
- **Детектор:** `grep POST /counterparties` (усі відправники) → звірити наявність guard з `.trim()`.

### MP-B7. Enum-axis розширення

Новий enum-value → додати в exhaustive `Record<Enum, ...>` (compile-check ловить пропуск);
НЕ `Partial<Record>`. + runtime-assert exhaustiveness у spec.

- **Еталон:** `settlements.service.ts:25` `Record<SettlementTransactionType, 1|-1>` (коментар:
  «Record not Partial — новий enum-value → compile-error»); `settlements.invariants.spec.ts`
  (forEach по `Object.values(enum)` + expect на кожен ключ).
- **Клас багів:** `Partial<Record>` → новий enum без запису = runtime exception у проді (блокує
  фінансову операцію).
- **Детектор:** `Partial<Record<` для sign/label/transition-мап; inline списки типів.

### MP-B8. Міграції ручні SQL (БД offline)

Enum `ADD VALUE` — ОКРЕМА міграція перед використанням (PG-constraint); backfill ідемпотентний
recompute (не «переворот»); `syncVersion++` для реплік; reconcile з BACKUP.

- **Еталон:** `20260902120000_add_supplier_settlement_types` (лише ADD VALUE) → окремо
  `20260902120100_backfill_...` (re-type по documentType + `balance=Σ signed(tx)` + syncVersion++).
- **Клас багів:** `ADD VALUE` + DML з новим value в одній транзакції → PG помилка; неідемпотентний
  backfill ламає при повторному прогоні.
- **Детектор:** `ADD VALUE` + INSERT/UPDATE у тому ж migration.sql.

### MP-B9. Гарячий шлях: hoisting алокацій + sibling-drift audit

`SORT_FIELDS`/`INCLUDE`/`SELECT` — на module-level (одна алокація), не в тіло `findAll`/`transition`
(polling). Після оптимізації одного findAll — grep ВСІХ однотипних сервісів (sibling-drift).

- **Еталон:** `SLOT_INCLUDE`/`CONFLICT_SELECT` (calendar), `PO_LINE_GOOD_INCLUDE`, narrow-select у transition.
- **Клас багів:** re-allocation select/include на polling-ендпоінтах; overfetch relation-ів;
  drift — один findAll оптимізували, «брати» лишили.
- **Детектор:** inline `include:`/`select:` у тілі findAll; `take: 1000`.

### MP-B10. Атомарність фінансових інваріантів

Consume + decrement в ОДНІЙ `$transaction` (інваріант тримається за конструкцією); FIFO span —
while-пагінація з guard проти нескінченного циклу; append-only логи (audit trail); explicit timeout.

- **Еталон:** `batch.service.ts:consumeBatch` (while-пагінація + `progressed` guard + throw при
  нестачі), викликається ПІСЛЯ `stockItem.upsert` → `Σ remainingQty == quantity`;
  `settlements.createTransaction` (Promise.all transaction+account у $transaction).
- **Клас багів:** partial state (списали з партії, рух не створився); втрата audit trail.

### MP-B12. URI-версіонування API (/api/v1) + version-neutral винятки

`enableVersioning({type:URI, defaultVersion:'1'})` після `setGlobalPrefix('api')` → бізнес-роути під
`/api/v1/*`. Мета: v2 співіснує з v1 для offline-клієнтів, що оновлюються рідко (mobile, cloud-sync).

- **Еталон:** `apps/api/src/main.ts` (enableVersioning); `health.controller` + `work-orders-public.controller`
  (`@Controller({ path, version: VERSION_NEUTRAL })`).
- **VERSION_NEUTRAL — для роутів із зовнішнім fixed-URL консюмером** (URL НЕ отримує /v1): health
  (docker/installer healthcheck), public share-лінки (SMS/email). Перед версіонуванням — grep УСІ
  `@Controller` і спитати «хто б'є цей URL іззовні?»: docker healthcheck, installer PS, SMS/email-лінк,
  external webhook/callback, cross-service. Такі → VERSION_NEUTRAL, інакше тихо переїдуть і зламаються.
- **Клас багів (усі знайдено QA-ланцюгом, unit-тести з мок-apiFetch їх НЕ ловлять):**
  1. **Прямий fetch поза api-client** (AuthProvider context.tsx, mobile upload.ts мали власний BASE_URL) →
     лишився на голому /api → 404. Re-grep `fetch(.../api/` у web+mobile, не лише api-client.
  2. **Cookie path coupling:** httpOnly-cookie з `path:'/api/auth'` НЕ дійде до `/api/v1/auth/*` (browser
     path-prefix match). Cookie path МУСИТЬ мінятись синхронно з версійним префіксом (set + УСІ clear).
  3. **Спільний client-префікс-хелпер маскує neutral/versioned поділ:** `publicFetch` форсив /api/v1, але
     version-neutral public-роут живе під /api → розділити (`publicNeutralFetch` → /api).
     app-404 (handler кинув NotFound) vs routing-404 («Cannot GET») — діагностика: routing-404 = клієнт
     б'є не той префікс.
- **E2E:** glob `route('**/api/**')` матчить і /api/v1 (не чіпати); exact-match `route('**/api/auth/**')`
  → оновити на /v1 (інакше мок не перехоплює, тест б'є живий бек). setup-auth/fixtures login → /api/v1.

### MP-B11. Централізований DLQ для BullMQ (durable dead-letter)

Job, що вичерпав УСІ спроби (attempts), не має тихо зникати після `removeOnFail:N` — для offline-first
(ПРРО/SMS/webhook) втрачений job = юридична/бізнес-проблема. Централізований durable DLQ у БД-таблиці.

- **Еталон:** `modules/dead-letter/` — `DeadLetterWorkerHost extends WorkerHost` з `protected
deadLetterOnFailed(job,err)` (терминальний гейт `attemptsMade >= opts.attempts`); процесори extend-ять
  базу + однорядковий `@OnWorkerEvent('failed') onFailed(j,e){return this.deadLetterOnFailed(j,e)}`.
  `DeadLetterService.capture` пише `DeadLetterJob` (TENANT_EXEMPT, orgId nullable) через `runUnscoped`.
- **ЧОМУ у процесі, не QueueEvents:** BullMQ5 `QueueEvents.failed` несе лише `{jobId,failedReason}` (без
  attemptsMade/data), а `removeOnFail` може евіктнути job до `getJob` → втрата capture. `@OnWorkerEvent`
  має повний `Job` синхронно.
- **Клас багів (money/legal infra):**
  1. **Secrets-at-rest:** `payload: job.data` персистить креденшели plaintext (webhooks `secret: ep.secret`).
     → `sanitizePayload()` з **токен-орієнтованим** `isSensitiveKey()` (НЕ плоский substring-regex:
     `auth|sign|pass|key` ловлять `authorId/assignee/passenger/bypass` → over-redaction нищить діагностику).
  2. **Non-JSON-safe payload:** BigInt/Date/cyclic у job.data → Prisma JSONB throw → fail-open ковтає →
     ТИХА втрата DLQ-рядка. → нормалізувати (BigInt→String/Date→ISO/cyclic→'[CIRCULAR]', depth-cap).
  3. **TENANT_EXEMPT write:** `resolve` мусить `updateMany({where:{id,orgId}})` (orgId у write-where), НЕ
     `findFirst({id,orgId})→update({where:{id}})` (guard не страхує exempt-модель → race-вікно).

---

## FRONTEND

### MP-F1. onSaved контракт + модалка lifecycle

create→edit транзиція через `onSaved(cp, isNew)`; tenant-guard по live-ref; reqRef stale-drop
(bump при close, discard in-flight); dirty-form confirm.

- **Еталон:** `CounterpartyEditModal` (isNew→edit-режим); reqRef stale-drop — `GoodPickerModal.tsx:52`
  (`reqId !== reqRef.current` return, bump при close).
- **Клас багів:** stale-response від попереднього модала перезаписує новий; setState після unmount.

### MP-F2. Схема-driven UI

`COLUMNS`-масив + `panel-schema` + `useListPage` → toggle/reorder/rename/панель автоматично, без
хардкоду полів у JSX.

- **Еталон:** `useListPage.ts` (композитний хук); споживач `counterparties/page.tsx` (`CRM_COLUMNS`
  - `COUNTERPARTY_PANEL_SCHEMA` + `buildPanelFields`).
- **Клас багів:** хардкод `<th>`/`<td>` → toggle/reorder не працюють; drift список↔панель.

### MP-F3. Skip-first-run / hydration у toggle-useEffect

Persist-стан: SSR-safe дефолт у `useState`, гідратація з localStorage в ОКРЕМОМУ effect
(deps=[pageKey], `typeof window === 'undefined' return`); persist лише в user-actions, не в effect.
Skip-first-run ref скидається на зміну parent-id.

- **Еталон:** `useTableColumns.ts:48-74` (hydrate-effect окремо, persist у toggle/reorder).
- **Клас багів:** effect що пише дефолт назад → цикл/скидання вибору; дубль-fetch при зміні parent-id
  (skip-first-run ref не скинутий на CP-switch).

### MP-F4. Спільний хелпер після 3-ї копії

Третя inline-копія логіки → винести в `lib/utils`.

- **Еталон (`lib/utils.ts`):** `settlementBalanceTone` (Bug #606), `displayCounterpartyName` (Bug #139),
  `daysUntil` (4 IIFE), `UUID_RE`, `calcVatTotals`, `toIdMap`.
- **Клас багів:** N копій евристики розходяться (одну виправили, інші ні).
- **Детектор:** повтори `balance > 0 ?`, inline `[lastName, firstName].join`, inline UUID-regex поза utils.

### MP-F5. SSR-safe today

`useState(0|null)` + `useEffect(() => setTodayMs(Date.now()), [])` замість `new Date()` у render;
`daysUntil(date, nowMs)` повертає null коли `!nowMs` — SSR-safe за конструкцією.

- **Еталон:** `counterparties/[id]/PageClient.tsx` (`todayMs`) + `ExpiryBadge`; 17+ споживачів.
- **Клас багів:** `new Date()` у render → server≠client → hydration mismatch, бейджі «expired/soon» мигають.
- **Детектор:** `new Date()`/`Date.now()` у render-body (не в effect/handler).

---

## MP-F6 — Форми: react-hook-form + спільна zod-схема (ЄДИНЕ джерело валідації)

Валідація форм НЕ дублюється між фронтом і беком. Одна zod-схема у `@sto/shared` валідує обидва боки:
web через `zodResolver`, бек через `ZodValidationPipe`. Усуває клас багів «фронт каже ОК, бек 400/500».

**Схема** — `packages/shared/src/schemas/forms/<domain>.schema.ts`, з примітивів `schemas/validators.ts`
(reuse `optionalString`/`optionalUuid`/`optionalNonNegNumber` — коерсять рядкові web-поля: `'' → undefined`,
`'350' → 350`). Експорт через `schemas/forms/index.ts`. **Після зміни shared — `pnpm --filter @sto/shared build:cjs`**
(api споживає CJS `dist`, не source; web бачить source через `transpilePackages`).

```ts
// good.schema.ts
export const goodFormSchema = z.object({
  name: z.string().trim().min(1, 'Вкажіть назву товару'),
  purchasePrice: optionalNonNegNumber(),
  brandId: optionalUuid(),
  // ...
});
export type GoodFormValues = z.infer<typeof goodFormSchema>; // після парсингу (number/undefined)
export type GoodFormInput = z.input<typeof goodFormSchema>; // web-стан (рядки) для useForm
export const goodUpdateSchema = goodFormSchema.partial(); // PATCH — усі поля опційні
```

**Бек** — `@Body(new ZodValidationPipe(schema)) dto: GoodFormValues`
(`apps/api/src/common/pipes/zod-validation.pipe.ts`). Pipe дзеркалить формат 400 глобального
`validationExceptionFactory` (`{ statusCode, message: string[], error }` укр.), тож контракт відповіді
НЕ змінюється — `apiFetch` і всі споживачі працюють без змін, class-validator та zod-DTO співіснують безпечно.

**Фронт** — `useForm<GoodFormInput>({ resolver: zodResolver(goodFormSchema), defaultValues })`:

- `{...register('field')}` + `errorMessage={errors.field?.message}` → **per-field inline-помилки** (нове).
- Взаємозалежні / кастомні поля (EntityPicker, залежні селекти) — `setValue('f', v, { shouldDirty: true })` + `watch`.
- `reset(data)` при відкритті/зміні сутності → встановлює «чисту» базу; програмне заповнення НЕ вмикає dirty
  (уникнення Bug #639-класу з ручним markDirty).
- **Міст у `useDirtyForm`:** `useEffect([formState.isDirty]) → isDirty ? markDirty() : resetDirty()` —
  зберігає `DirtyConfirmDialog` + beforeunload-guard.
- `handleSubmit(onValid)` → `onValid` отримує коерснуті значення (числа — number); синхронний `savingRef`-guard
  лишається (WEB-H3 double-submit).

- **Еталон:** `apps/web/src/components/ui/GoodEditModal.tsx` (пілот); схема `good.schema.ts`.
- **Клас багів:** ручна useState-валідація розсипана по хендлерах, 1 банер помилки, рас-синк із class-validator DTO.
- **Детектор:** нова модалка з `useState`-полями + ручні `if (!x) setError(...)` перед submit → мігрувати на MP-F6.

### MP-F6.1 — Line-items через useFieldArray (масиви рядків)

Форма з масивом рядків (Invoice/PO/StockDoc lines) — `useFieldArray({ control, name: 'lines' })` замість
`useState<Line[]>`. Схема: `lines: z.array(lineSchema).default([])` (per-field помилки на шлях `['lines', i, 'field']`).

- **Еталон:** `InvoiceCreateModal.tsx` (перший useFieldArray) + `invoice.schema.ts`.
- **Read-only рядки + inline-add:** якщо існуючі рядки НЕ редагуються inline (редагування = видалити+додати),
  `fields.map` рендерить read-only рядки; окремий локальний `newLine` useState для inline-add, `append(newLine)`
  на «+», `remove(index)` на видалення. Живі значення — `watch('lines')` (не `field` з useFieldArray — воно snapshot).
- **Lines у ТІЛІ create/update (StockDoc/SupplierReturn/PO — ДОМІНУЮЧИЙ варіант, Фаза 4):** бек приймає
  `dto.lines` і створює/пересоздає рядки в атомарному `$transaction` — БЕЗ окремого `/lines`-endpoint.
  Submit ПРОСТИЙ: `handleSubmit(onValid)` → один POST/PATCH з `lines` у тілі. **Без** multi-request retry,
  createdLineRef, DELETE-diff (усе робить бек транзакційно). Ризик нижчий за Invoice-варіант.
  - **Inline-edit рядка:** `register(\`lines.${index}.quantity\`)`для прямого редагування (SupplierReturn),
АБО staging`editingLine`useState +`update(index, {...editingLine})`(PO). ⚠️ **row-match за`field.id`**
(RHF-генерований), НЕ за власним `_key`—`field.id ≠ _key`, інакше edit-row ніколи не активується
(реальний баг, спіймано у Фазі 4 review). `startEdit(line, index, field.id)`тримає`field.id`.
  - **Display/persist-поля поза схемою** (goodName/unit/unitOfMeasureId/pricedSalePrice): зберігаються у
    field-об'єкті (RHF не втрачає їх у runtime), читаються через `line as unknown as {...}` cast; при PATCH
    ті, що потрібні беку (unitOfMeasureId), беруться з `getValues('lines')` за індексом.
  - **Оманлива submit-помилка:** якщо submit читає `safeParse(getValues())` вручну (щоб повернути id, як PO
    handleCreate) — НЕ хардкодь «Оберіть X»; бери `err.issues[0].message` (українські зі схеми) + префікс
    `Рядок N:` коли `path[0]==='lines'`. Інакше line-item фейл (порожня ціна) показує помилку про шапку.
- **Multi-request submit** (коли бек не приймає lines у тілі документа, як Invoice — рядки окремими POST /lines):
  RHF-масив локальний; `handleSubmit(onValid)` рахує похідні (напр. `amount` зі суми рядків), POST шапку,
  далі цикл POST/DELETE рядків. **Retry-safety зберегти:** `createdDocRef` (не плодити дублі документа на retry),
  `initialLineIdsRef` diff для DELETE прибраних. Читати рядки через `getValues('lines')`, НЕ мутувати field-array у циклі.
- **Тип field-item ширший за схему:** локальні `_key`/`id`/`lineTotalWithVat` — у field-item, не валідуються
  (лишити `.optional()` у формовій line-схемі або widened local type).
- **Тест:** «додати позицію → рядок рендериться у таблиці» + збережені double-submit/DELETE-diff регреси.
  ⚠️ Фікстури контрагента/UUID-полів МУСЯТЬ бути валідними UUID (схема тепер `.uuid()` — старий `'cp1'` → submit блоковано).
- **SHIM-bridge для дуже великих модалок** (WorkOrder 2372р, ~700р money-логіки): коли повне
  переписування header/lines-JSX ризиковане, тримай RHF як джерело правди, але місток над старим
  useState-surface: `form`/`lines`/`parts` = `useMemo`-відбиток `watch()`; `setForm`/`setLines`/`setParts`
  = shim-и що diff-ять `getValues()` і пишуть через `setValue({shouldDirty:true})`/`replace()`. Уся наявна
  логіка читає `form.*`/`lines` без змін → money-код зберігається byte-for-byte. Row identity лишається
  `_key` (не `field.id`), бо parent не ітерує `fields` — суб-компоненти ітерують `_key`-несучий `watch()`-масив,
  а `replace()` зберігає `_key`. Валідація — гейт `workOrderFormSchema.safeParse(getValues())` перед submit.
- **UA-кома у FORM-схемах (ОБОВʼЯЗКОВО для числових полів):** free-text інпути приймають `1,5` (укр.
  роздільник). `numericString()`/`z.coerce.number()` роблять `Number('1,5')=NaN` → safeParse-гейт хибно
  блокує submit; `parseFloat('1,5')=1` — ще гірше (тихе усічення). Числові поля FORM-схем → `moneyString()` /
  `optionalMoneyNumber()` (comma-aware `.replace(',','.')`). ENDPOINT-схеми (ZodValidationPipe) не чіпати —
  туди летить уже-numeric JSON. Детектор: `grep -n "numericString()\|z\.coerce\.number\|parseFloat" *.schema.ts`.

---

## Зведення grep-детекторів (для CI / review)

| Патерн                   | Сигнал порушення                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- |
| MP-B1/B7 SOT осі         | `type ==?= 'CHARGE'\|'PAYMENT'`; `Partial<Record<`                                    |
| MP-B2 Централізація      | `prisma.stockItem.update(`, `settlementAccount.update(`, `.delete(` поза service      |
| MP-B3 Tenant/soft-delete | `findFirst`/`findMany` без `orgId`; `where:{id}` в update                             |
| MP-B4/F1 Async guard     | `await apiFetch` → `setState` без `Ref.current !== …AtStart`                          |
| MP-B5 Config             | magic `invoiceDueDays`/`'FIFO'` поза settings                                         |
| MP-B6 Cross-field        | POST-точки без дзеркального guard + `.trim()`                                         |
| MP-B8 Міграції           | `ADD VALUE` + DML в одному файлі                                                      |
| MP-B9 Hot-path           | inline `include:`/`select:` у findAll; `take: 1000`                                   |
| MP-B10 Sentinel UUID FK  | in-band `''`-sentinel у `@db.Uuid` — тип має бути `string \| null`, не порожній рядок |
| MP-F5 SSR today          | `new Date()`/`Date.now()` у render-body                                               |
