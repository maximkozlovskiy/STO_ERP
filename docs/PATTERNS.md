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

| Hook                   | Файл                      | Що робить                                       |
| ---------------------- | ------------------------- | ----------------------------------------------- |
| `useDetailPanel`       | `useDetailPanel.ts`       | localStorage toggle для бокової панелі          |
| `useDetailPanelConfig` | `useDetailPanelConfig.ts` | Offline-first конфіг полів (localStorage + API) |
| `useDirtyForm`         | `useDirtyForm.ts`         | `confirmClose(): Promise<boolean>`              |
| `useBulkSelect`        | `useBulkSelect.ts`        | Множинний вибір, auto-prune stale IDs           |
| `useInlineEdit`        | `useInlineEdit.ts`        | Inline editing з savingRef race guard           |
| `useSavedFilters`      | `useSavedFilters.ts`      | Пресети фільтрів в localStorage                 |
| `useUiFeatures`        | `useUiFeatures.ts`        | 10 UX-прапорців, module-level cache + TTL       |
| `useConflictCheck`     | `useConflictCheck.ts`     | Conflict probe для calendar slots               |
| `useTabBar`            | `useTabBar.ts`            | activateTab/closeTab                            |

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
