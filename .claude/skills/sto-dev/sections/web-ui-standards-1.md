# sto-dev — web-ui-standards-1

> Частина скіла `sto-dev`; винесено дослівно, щоб кожен файл влазив в один Read.

## §14 Модульність і Універсальність UI

> **Правило:** Перш ніж писати inline-логіку в page.tsx — запитай: "Це буде потрібно ще хоча б раз?" Якщо так — одразу виносити в компонент. Один раз — inline припустимо.

### Коли виносити в компонент

| Патерн                            | Ознаки для винесення                      | Куди                            |
| --------------------------------- | ----------------------------------------- | ------------------------------- |
| Picker зі списком + пошуком       | `items[]` + `onSelect` + пошукове поле    | `<PickerModal<T>>`              |
| Форма створення/редагування       | 3+ поля + збереження + валідація          | `<XxxForm>` окремий файл        |
| Список з CRUD                     | таблиця + кнопки edit/delete              | `<XxxList>` або `<DataTable>`   |
| Підтвердження дії                 | "Видалити?", "Скасувати?"                 | `<ConfirmDialog>` (вже є)       |
| Бейдж статусу                     | кольоровий статус + лейбл                 | `<StatusBadge>`                 |
| Бейдж терміну (прострочено/скоро) | дата + поріг днів + червоний/жовтий badge | `<ExpiryBadge>` + `daysUntil()` |

### ExpiryBadge — канонічний бейдж "прострочено / скоро"

> **Шлях:** `apps/web/src/components/ui/expiry-badge.tsx` + helper `daysUntil()` у `lib/utils.ts`. Будь-яка логіка "скільки днів до дати → червоний/жовтий бейдж" (страховка, техогляд, ТО, гарантія). `nowMs` завжди з `useState`/`useEffect` (SSR-safe), ніколи `new Date()` у render. `nowMs=0` → бейдж не рендериться (дані ще не готові).

```tsx
// ✅ Один компонент — конфігуровані лейбли + поріг
import { ExpiryBadge } from '@/components/ui/expiry-badge';
<ExpiryBadge date={vehicle.insuranceExpiry} nowMs={today?.getTime() ?? 0} expiredLabel="Страховка прострочена" />
<ExpiryBadge date={sc.nextMaintenanceDate} nowMs={nowMs} expiredLabel="Прострочено" soonLabel="Незабаром" soonDays={14} />

// ✅ Лише обчислення без бейджа — helper
import { daysUntil } from '@/lib/utils';
const diff = daysUntil(date, nowMs);            // number | null (null = немає дати / nowMs=0)
const isSoon = diff !== null && diff <= 30;

// ❌ НЕ inline-IIFE: дубльована математика дати + червоний/жовтий <span> у JSX
{today && (() => {
  const diffDays = Math.ceil((new Date(date).getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return <span className="...bg-destructive-subtle...">Прострочено</span>;
  if (diffDays <= 30) return <span className="...bg-warning-subtle...">Скоро</span>;
  return null;
})()}
```

### PickerModal — канонічний компонент для вибору зі списку

> **Шлях:** `apps/web/src/components/ui/search-picker-modal.tsx`. Використовується коли потрібно вибрати одну сутність зі списку з пошуком по реквізитах. Тригер поле — завжди через `EntityPickerField` (§24).

```tsx
// ✅ Завжди PickerModal для вибору сутності зі списку
import { PickerModal } from '@/components/ui/picker-modal';

<PickerModal<BankAccount>
  open={pickerOpen}
  onClose={() => setPickerOpen(false)}
  title="Оберіть банківський рахунок"
  items={bankAccounts}
  selectedId={form.bankAccountId}
  searchKeys={['name', 'ibanUA', 'bankName', 'mfo', 'edrpou']}
  searchPlaceholder="Пошук за назвою, IBAN, МФО..."
  emptyText="Рахунки не додано"
  onSelect={(b) => { setForm(f => ({ ...f, bankAccountId: b.id })); }}
  renderItem={(b) => (
    <>
      <div className="font-medium text-foreground text-sm">{b.name}</div>
      <div className="font-mono text-xs text-muted-foreground">{b.ibanUA}</div>
    </>
  )}
/>

// ❌ НЕ робити inline Modal зі своїм пошуком
<Modal open={open} ...>
  <Input value={q} onChange={...} />
  {items.filter(...).map(item => <button .../>)}
</Modal>
```

### Заборонені inline-патерни

```tsx
// ❌ Пошук реалізований через IIFE в JSX
{
  (() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter(i => i.name.toLowerCase().includes(q));
    return filtered.map(i => <button key={i.id}>...</button>);
  })();
}

// ❌ Стан picker-модалу дублюється для кожного поля (pickerQuery1, pickerQuery2...)
const [pickerQuery, setPickerQuery] = useState(''); // не потрібен — PickerModal керує сам

// ❌ Логіка форми живе у page.tsx якщо форма > 5 полів
// → виносити в src/components/{domain}/{Domain}Form.tsx
```

### Checklist перед здачею UI-коду

```
Компоненти
  [ ] Picker зі списком → <SearchPickerModal<T>> або <PickerModal<T>>
  [ ] Поле-посилання → <EntityPickerField> (НЕ кастомна кнопка з Search іконкою)
  [ ] Лупа у EntityPickerField → відкриває *EditModal, НЕ router.push/window.open
  [ ] Форма редагування об'єкта → окремий *EditModal компонент (не inline у page.tsx)
  [ ] *EditModal зареєстрований у реєстрі §24.4 (web-ui-standards-2.md)
  [ ] Inline IIFE `{(() => {...})()}` у JSX → замінити компонентом
  [ ] Форма > 5 полів у page.tsx → виносити в окремий файл
  [ ] Підтвердження дії → <ConfirmDialog>

Стан
  [ ] Немає дубльованих query/loading стейтів для однотипних picker-ів
  [ ] pickerQuery НЕ є зовнішнім стейтом — SearchPickerModal/PickerModal керує пошуком сам
  [ ] lazy fetch у openDetail() — не у useEffect на mount
```

---

## §25 — DRY: хуки і компоненти як єдине місце правди

> **Правило:** Якщо один і той самий блок коду (useState+useEffect, JSX-секція) зустрічається у 2+ файлах — виносити в хук або компонент. Завжди.

### §25.1 — useBulkIndeterminate: замість 7-рядкового блоку

Дублювалось у кожній list-сторінці:

```ts
const bulkSelect = useBulkSelect(items);
const selectAllRef = useRef<HTMLInputElement | null>(null);
useEffect(() => {
  if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
}, [bulkSelect.someSelected]);
```

Рішення: `hooks/useBulkIndeterminate.ts`

```ts
// ✅ Один рядок замість 7
const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(items);
```

**Правило:** `useBulkIndeterminate` завжди після React Query виклику — так `items` вже має стабільну ref.

### §25.2 — useCachedRefData: замість 25-рядкового ref-cache патерну

Паттерн `getCached → show stale → fetch → setCache → setState` повторювався у 5+ місцях. Рішення: `hooks/useCachedRefData.ts`

```ts
// ✅ Замість 25 рядків — 1 рядок
const { data: branches } = useCachedRefData<Branch[]>('cache:branches', '/branches', []);

// З трансформом (якщо API повертає { items: T[] })
const { data: brands } = useCachedRefData(
  'cache:brands',
  '/brands?limit=200',
  [],
  raw => (raw as { items: Brand[] }).items,
);
```

**Коли НЕ використовувати:** якщо після завантаження є side-effect (`setForm(f => ({ ...f, branchId: bs[0].id }))`). В такому випадку залишати оригінальний `useEffect` з `getCached`/`setCache`.

### §25.3 — useListPage: спільна інфраструктура list-сторінок

Кожна list-сторінка повторювала 7+ хуків (`useUiFeatures`, `page/setPage`, `showDeleted`, `useTableColumns`, `useColumnDrag`, `useDetailPanel`, `useDetailPanelConfig`, `useSavedFilters`, `activeSavedFilterId`). Рішення: `hooks/useListPage.ts` — один виклик замість 9:

```ts
// ✅ Generic TFilters для типізованого savedFilters
const {
  page, setPage, resetPage,
  showDeleted, setShowDeleted,
  activeSavedFilterId, setActiveSavedFilterId,
  tableColumns: { visibleColumns, orderedColumns, toggle: toggleCol, ... },
  dragProps,
  detailPanel, panelConfig,
  savedFilters: { saved, save, remove },
  features,
  limit,
} = useListPage<InvoiceFilters>('invoices', INVOICE_COLUMNS, { defaultLimit: 20 });
```

**Порядок викликів (обов'язковий):**

```ts
// 1. useListPage — не залежить від items
const lp = useListPage<TFilters>(pageKey, COLUMNS);

// 2. Специфічні фільтри сторінки
const [status, setStatus] = useState('');

// 3. React Query — використовує page/limit/showDeleted з useListPage
const { data } = useXxx({ page: lp.page, limit: lp.limit, ... });
const items = data?.items ?? EMPTY_ITEMS;

// 4. useBulkIndeterminate — ПІСЛЯ items (стабільна ref)
const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(items);
```

### §25.4 — Розбиття моноліту: коли файл > 400 рядків

**Правило:** файл > 400 рядків → шукати природні межі для розбиття.

```
page.tsx (1500+ рядків)
  ↓ виносити
hooks/useXxxState.ts     ← весь useState, useEffect, handlers
XxxSection.tsx           ← окрема секція JSX (таблиця, галерея, etc.)
XxxModal.tsx             ← модальна форма в components/ui/
page.tsx (200-400 рядків) ← тільки orchestration + рендер view-режимів
```

Конкретні патерни (реалізовано в STO ERP):

| Компонент                         | До          | Після                                                                |
| --------------------------------- | ----------- | -------------------------------------------------------------------- |
| `GoodEditModal.tsx`               | 1352 рядки  | 522 (контейнер) + `GoodBarcodeTab` + `GoodBatchesTab` + `GoodUoMTab` |
| `work-orders/[id]/PageClient.tsx` | 1579 рядків | 1252 (orchestrator) + 4 `*Section.tsx`                               |
| `calendar/page.tsx`               | 1518 рядків | 239 (thin render) + `useCalendarState.ts` + `CalendarDayGrid.tsx`    |

**Tab-компоненти:** кожна ModalTabs вкладка → окремий компонент. Props: `goodId + orgId + onCountChange` (для badge у ModalTabs):

```ts
<GoodBarcodeTab goodId={good.id} onCountChange={n => setBarcodeCount(n)} />
<GoodBatchesTab goodId={good.id} />
<GoodUoMTab goodId={good.id} onChanged={() => refetch()} />
```

**Секції сторінки:** props-drilling (не Context) — дані завантажені в orchestrator, передаємо явно; `onChanged` callback → orchestrator робить refetch; кожна секція самодостатня для рендеру, не для fetch.

### §25.5 — Константи в одному місці: packages/shared

**Дублювати заборонено.** Всі labels/badges для статусів і типів — в `packages/shared/src/constants/statuses.ts`.

| Що                                          | Де НЕ визначати                                        | Де визначати  |
| ------------------------------------------- | ------------------------------------------------------ | ------------- |
| `WO_STATUS_LABELS`, `INVOICE_STATUS_LABELS` | `page.tsx`                                             | `@sto/shared` |
| `COUNTERPARTY_TYPE_LABELS/BADGE`            | `counterparties/page.tsx`, `CounterpartyEditModal.tsx` | `@sto/shared` |
| `CONTRACT_TYPE_LABELS`                      | `[id]/PageClient.tsx`                                  | `@sto/shared` |
| `GOOD_TYPE_LABELS/BADGE`                    | `GoodsTab.tsx`                                         | `@sto/shared` |

```ts
// ✅ Завжди
import { COUNTERPARTY_TYPE_LABELS, COUNTERPARTY_TYPE_BADGE } from '@sto/shared';
const TYPE_LABELS = COUNTERPARTY_TYPE_LABELS; // alias для зворотної сумісності

// ❌ НЕ визначати inline
const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', ... };
```

### §25.6 — Backend: спільні utils замість дублікатів

```ts
// ✅ common/utils/math.ts
import { safeCoeff } from '../../common/utils/math';
// Замість копій функції в work-orders.service.ts та invoices.service.ts

// ✅ common/utils/fsm.ts
import { assertFsmTransition } from '../../common/utils/fsm';
assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);
// Замість 4-рядкового блоку в 4 сервісах
```

**Що іде в `common/utils/`:** математичні хелпери (`safeCoeff`), FSM валідація (`assertFsmTransition`), дата/час (`kyivToday` — вже є), security guards (`validatePublicUrl` — вже є). **Що НЕ іде:** бізнес-логіка (залишається в модулях).

### §25.7 — Checklist DRY-рефакторингу

```
Перед написанням нового коду:
  [ ] Чи є цей паттерн вже в hooks/ ? Якщо так — використати
  [ ] Чи є ця константа вже в @sto/shared ? Якщо так — імпортувати
  [ ] Чи буде ця логіка потрібна ще раз? Якщо так — виносити зразу

Після написання:
  [ ] Файл > 400 рядків → знайти природні межі для розбиття
  [ ] Однаковий блок 2+ разів → витягти в хук або компонент
  [ ] Label/badge константа не в shared → перенести
```

---

## §18 — Modal + ModalTabs для 1-N зв'язків

### §18.1 — Структура Edit Modal з ModalTabs

Коли сутність має 1+ дочірніх колекцій (контрагент → авто, товар → штрихкоди): основна форма + ModalTabs нижче.

```tsx
// ✅ Правильна організація
<Modal open={modal} onClose={closeModal} size="lg" title="Редагування X">
  {/* 1) Основні поля форми — завжди видимі */}
  <form className="space-y-4" onSubmit={e => e.preventDefault()}>
    <Input label="Назва" value={form.name} onChange={...} />
    {/* ...інші поля... */}
    {error && <p className="text-sm text-destructive-text">{error}</p>}
  </form>

  {/* 2) ModalTabs — тільки при редагуванні (не при створенні) */}
  {editingItem && (
    <ModalTabs
      tabs={[
        {
          key: 'children',
          label: 'Дочірні об'єкти',
          icon: <SomeIcon className="h-3.5 w-3.5" />,
          count: modalChildren.length,
          content: (
            <div className="space-y-3">
              {/* Loading / Error / Empty / List */}
            </div>
          ),
        },
        // ... інші вкладки
      ]}
    />
  )}

  {/* 3) Footer кнопки — після ModalTabs, у Modal footer */}
</Modal>
```

**State для дочірньої колекції** (по одному блоку на кожну):

```ts
const [modalChildren, setModalChildren] = useState<Child[]>([]);
const [modalChildrenLoading, setModalChildrenLoading] = useState(false);
const [childError, setChildError] = useState('');
const modalChildReqRef = useRef(0); // race guard (обов'язковий!)
```

**PATCH + оновлення списку після мутації:**

```ts
// Після успішного PATCH основних даних:
setItems(prev => prev.map(i => (i.id === editingItem.id ? { ...i, ...updated } : i)));
// Після POST нового дочірнього елемента:
setModalChildren(prev => [...prev, created]);
// Після DELETE дочірнього елемента:
setModalChildren(prev => prev.filter(c => c.id !== deletedId));
```

### §18.2 — Loading/Error в контенті вкладки

Loading і error показуються **у tab.content**, не на рівні ModalTabs:

```tsx
content: (
  <div className="space-y-3">
    {/* Loading state */}
    {childrenLoading && (
      <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
    )}

    {/* Error state */}
    {!childrenLoading && childError && (
      <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
        {childError}
      </div>
    )}

    {/* Empty state */}
    {!childrenLoading && !childError && children.length === 0 && (
      <p className="text-[13px] text-muted-foreground text-center py-4">Нічого не знайдено</p>
    )}

    {/* List */}
    {!childrenLoading && !childError && children.length > 0 && (
      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-[13px]">
          {/* ... */}
        </table>
      </div>
    )}
  </div>
),
```

**count у вкладці** — обчислюється з поточного state (не від API), оновлюється в реальному часі при add/delete: `count: modalChildren.length`.

**Умовні вкладки** (показуємо лише якщо дані завантажені):

```tsx
tabs={[
  mainTab,
  ...(editingItem ? [childrenTab] : []),
  ...(editingItem && showBatches ? [batchesTab] : []),
]}
```

### §18.3 — Race guard + скидання стану при відкритті

`openEdit` в event handler → race guard: `const reqId = ++modalChildReqRef.current` + перевірка `if (modalChildReqRef.current !== reqId) return` в `.then/.catch/.finally`.

- Скидати `setModalChildren([])` + `setChildError('')` при відкритті (до fetch)
- Декілька колекцій → окремий reqRef для кожної; fetch паралельно через `Promise.all`
- ❌ `.catch(() => {})` — ковтає помилку; завжди `setChildError(err.message)`

### §18.4 — AnimatedBody: плавна зміна висоти Modal та collapsible-секцій

`<Modal>` анімує висоту автоматично. Для collapse-секцій поза Modal: `import { AnimatedBody } from '@/components/ui/modal'`; `{isOpen && <AnimatedBody className="px-4 py-3">{children}</AnimatedBody>}`.

- ❌ `maxHeight: '900px'` — magic number; ❌ `transition: 'max-height ...'` без ResizeObserver
- ✅ Для анімації 0↔контент з close: `outerRef`+`innerRef` + `ResizeObserver` + rAF закриття
- Приклад: `apps/web/src/app/(app)/calendar/page.tsx` (showAdd → formMounted/formVisible)

---

## §15 Schema-driven UI (metadata-driven rendering)

> **Правило:** Будь-який список полів для UI **ніколи не хардкодиться** в page.tsx. Поля описуються один раз у схемі поряд з TypeScript типом — і рендеряться автоматично.

### Коли застосовувати

| Сценарій                              | Рішення                                            |
| ------------------------------------- | -------------------------------------------------- |
| Detail Panel з 3+ полями              | `PanelFieldDef<T>[]` + `buildPanelFields()`        |
| Конфігурований список реквізитів      | schema + `useDetailPanelConfig`                    |
| Нова сторінка з інформаційною панеллю | Схема в `lib/panel-schema.ts`, НЕ масив у page.tsx |

### Структура

**`apps/web/src/lib/panel-schema.ts`** — єдине місце правди для всіх схем.

```typescript
// 1. Схема — satisfies гарантує що key існує в типі T
export const INVOICE_PANEL_SCHEMA = [
  { key: 'status',          label: 'Статус',       always: true }, // always=true — не ховати
  { key: 'counterpartyName',label: 'Контрагент' },
  { key: 'amount',          label: 'Сума',          type: 'money' }, // auto fmtMoney()
  { key: 'dueDate',         label: 'Термін оплати', type: 'date' },  // auto fmtDate()
  { key: 'notes',           label: 'Нотатки' },
] as const satisfies readonly PanelFieldDef<Invoice>[];

// 2. Рендеринг у page.tsx — замість N окремих <PanelField>
{buildPanelFields(inv, INVOICE_PANEL_SCHEMA, panelConfig.config, {
  // renderOverrides — тільки для полів що потребують Badge/кольорів
  status: v => <Badge variant={STATUS_BADGE[String(v)]}>{STATUS_LABELS[String(v)]}</Badge>,
}).map(f => (
  <PanelField key={f.key} fieldKey={f.key} label={f.label} value={f.value} hidden={f.hidden} />
))}

// 3. configFields у <DetailPanel> — через schemaToPanelConfigFields
<DetailPanel
  configFields={schemaToPanelConfigFields(INVOICE_PANEL_SCHEMA, panelConfig.config)}
  onToggleField={panelConfig.toggleField}
  onReorderFields={panelConfig.reorderFields}
  onReset={panelConfig.reset}
/>
```

### Типи полів (type)

| type             | Форматування                            |
| ---------------- | --------------------------------------- |
| `text` (default) | `String(value)`                         |
| `money`          | `fmtMoney(value) + ' ₴'`                |
| `date`           | `fmtDate(value)`                        |
| `datetime`       | `fmtDateTime(value)`                    |
| `number`         | `String(value)`                         |
| `node`           | власний `render()` або `renderOverride` |

### renderOverrides vs render у схемі

- **`renderOverrides`** (передається в `buildPanelFields`) — для per-сторінкової кастомізації (Badge, кольори що залежать від локальних констант)
- **`render` у схемі** — для кастомізації що не залежить від page-контексту (уникай, бо schema.ts не має доступу до React компонентів)

### useDetailPanelConfig — що повертає

```typescript
const panelConfig = useDetailPanelConfig('invoices-panel'); // ключ унікальний per-сторінка

panelConfig.config; // { hiddenFields: string[], fieldOrder: string[] }
panelConfig.isFieldHidden; // (key) => boolean — для прямих перевірок
panelConfig.toggleField; // (key) => void
panelConfig.reorderFields; // (newOrder: string[]) => void
panelConfig.reset; // () => void
```

Стан зберігається в `localStorage` + синхронізується з API `/user-preferences/{pageKey}`.

### Як додати нове поле

Тільки в `lib/panel-schema.ts` — додати рядок у відповідну схему; поле автоматично з'являється в панелі, доступне для toggle/reorder, **жодних змін у page.tsx**:

```typescript
{ key: 'newField', label: 'Нова назва', type: 'text' }
```

### ❌ Заборонено

```typescript
// ❌ Хардкод масиву полів у page.tsx
const MY_PANEL_FIELDS = [
  { key: 'status', label: 'Статус' },
  { key: 'amount', label: 'Сума' },
] as const;

// ❌ Вручну перебирати поля без buildPanelFields (якщо полів 5+ — це вже порушення)
<PanelField hidden={panelConfig.isFieldHidden('status')} fieldKey="status" label="Статус" value={...} />
<PanelField hidden={panelConfig.isFieldHidden('amount')} fieldKey="amount" label="Сума" value={...} />
```

### ✅ Правильно

```typescript
// ✅ Схема в lib/panel-schema.ts, рендер через buildPanelFields
{buildPanelFields(record, MY_SCHEMA, panelConfig.config).map(f => (
  <PanelField key={f.key} fieldKey={f.key} label={f.label} value={f.value} hidden={f.hidden} />
))}
```

---
