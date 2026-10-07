# sto-dev — web

> Частина скіла `sto-dev`; винесено дослівно, щоб кожен файл влазив в один Read.

## Next.js 15 / Web

### Обов'язкові правила компонентів

```typescript
// ❌ SSR hydration mismatch — Date у render path
export default function Page() {
  const today = new Date().toLocaleDateString('uk-UA');  // UTC на сервері ≠ Kyiv на клієнті
  return <div>{today}</div>;
}

// ✅ useEffect + useState для date/time
const [today, setToday] = useState('');
useEffect(() => {
  setToday(new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }));
}, []);

// ❌ fetch/axios прямо в компоненті
useEffect(() => { fetch('/api/work-orders').then(...) }, []);

// ✅ TanStack Query hook
const { data, isLoading, error } = useWorkOrders(orgId, filters);

// ❌ Global loading/saving boolean для списку
const [saving, setSaving] = useState(false);
// ✅ Per-row id
const [savingId, setSavingId] = useState<string | null>(null);
// button: loading={savingId === row.id}

// ❌ Один error стейт для сторінки і форми
setError(formLoadError);  // перезаписує помилку списку
// ✅ Окремі стейти
const [pageError, setPageError] = useState<string | null>(null);
const [formError, setFormError] = useState<string | null>(null);
```

### i18n — двомовність uk/en ОБОВ'ЯЗКОВА у новому UI (патерн MP-F7 / MP-F7b, docs/PATTERNS.md)

Увесь `(app)` UI перекладено (28 namespaces). НОВИЙ user-facing текст НЕ хардкодиться — одразу `t()`.

```typescript
// ❌ Хардкод-кирилиця у JSX/атрибутах/тостах
<button>Зберегти</button>;
toast.success('Збережено');
<Input label="Найменування" />;

// ✅ react-i18next: namespace на область
const { t } = useTranslation('workOrders');   // або 'common' для generic
<button>{t('common:save')}</button>;
toast.success(t('toast.saved'));
<Input label={t('columns.name')} />;

// ❌ enum-мітка через shared-мапу напряму
{WO_STATUS_LABELS[status] ?? status}
// ✅ enum-обгортка (statuses.ts НЕ чіпати — backend PDF україномовний)
{woStatusLabel(status)}   // з @/i18n/enumLabel; 19 обгорток

// ❌ zod-повідомлення інлайн-рядком (шейр-схема біжить web+api)
z.string().min(1, 'Вкажіть назву');
// ✅ validation-KEY (резолвиться api-pipe / web i18nZodResolver / validateContactFields)
z.string().min(1, 'v.good.name.required');   // + додати у messages.uk + messages.en + VALIDATION_KEYS

// ❌ zodResolver напряму (не перекладе key-и)
useForm({ resolver: zodResolver(schema) });
// ✅ i18nZodResolver (перекладає validation-key-и рекурсивно)
useForm({ resolver: i18nZodResolver(schema) });   // @/lib/i18nZodResolver
```

Правила: (1) новий namespace → зареєструвати у `i18n/resources.ts` + `config.ts` ns[]; (2) uk-значення
byte-identical якщо мігруєш наявний рядок (тести асертять); (3) generic (Save/Cancel/Delete/Search) →
`common` namespace; (4) дати/числа/гроші — через `@/lib/format` (locale-aware, НЕ хардкод `uk-UA`);
(5) не перекладати: em-dash-плейсхолдери, `₴`, бренди, POST-data-defaults (напр. `maintenanceType:'ТО'`),
коментарі; (6) `t`-змінна конфліктує з `.map(t=>...)` loop-var → перейменувати loop-var. Деталі — MP-F7/MP-F7b.

### Event handler cleanup — завжди повертай cleanup з useEffect

```typescript
// ❌ Витік пам'яті — немає cleanup
useEffect(() => {
  window.addEventListener('resize', handleResize);
}, []);

// ✅ Завжди повертай cleanup
useEffect(() => {
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);

// ❌ setInterval без cleanup
useEffect(() => {
  setInterval(tick, 1000);
}, []);

// ✅
useEffect(() => {
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, []);
```

### Завантаження даних — loading state init

```typescript
// ❌ loading: false — нема спінера при першому рендері
const [loading, setLoading] = useState(false);
useEffect(() => {
  setLoading(true);
  fetch(...).finally(() => setLoading(false));
}, []);

// ✅ loading: true — спінер відразу
const [loading, setLoading] = useState(true);
useEffect(() => {
  fetch(...).finally(() => setLoading(false));
}, []);
```

### apiFetch — завжди через централізований клієнт (auth + base URL + error handling)

```typescript
// ❌ Прямий fetch
const res = await fetch(`/api/work-orders`, { headers: { Authorization: `Bearer ${token}` } });

// ✅ apiFetch
import { apiFetch } from '@/lib/api-client';
const data = await apiFetch<WorkOrder[]>('/work-orders');
```

---

## UX/UI Features System (Phase 20)

> 10 UX-прапорців у `OrganisationSettings.uiFeatures` (JSON, per-org), всі default `true`. Endpoint `GET /settings/ui-features` (всі ролі). Module-level cache з TTL — один fetch/сесію; при помилці кешує DEFAULTS на 60 сек. Слухає `sto:logout` → скидає до DEFAULTS.

### uiFeatures — повна схема

```typescript
// apps/api/src/modules/settings/settings.dto.ts
interface UiFeatures {
  toastEnabled: boolean; // Toast-сповіщення після мутацій
  unsavedGuardEnabled: boolean; // Попередження при закритті брудної форми
  stockIndicatorEnabled: boolean; // "Доступно: N шт." при виборі запчастини
  commandPaletteEnabled: boolean; // Ctrl+K → Command Palette
  keyboardShortcutsEnabled: boolean; // Alt+W/D/C/I/N та інші глобальні шорткати
  savedFiltersEnabled: boolean; // Збережені пресети фільтрів (localStorage)
  inlineEditEnabled: boolean; // Редагування прямо у рядку таблиці
  syncIndicatorEnabled: boolean; // Індикатор online/offline у sidebar
  notificationCenterEnabled: boolean; // Дзвоник з лічильником непрочитаних
  bulkActionsEnabled: boolean; // Чекбокси + BulkActionsBar у таблицях
}
const UI_FEATURES_DEFAULTS: UiFeatures = {/* всі true */};
```

### useUiFeatures — отримання прапорців

```typescript
const features = useUiFeatures();
if (features.toastEnabled) toast.success('Збережено');
{features.bulkActionsEnabled && <BulkActionsBar ... />}
// Інвалідація після зміни: invalidateUiFeaturesCache() → dispatch 'sto:ui-features-change'
```

### Хуки/компоненти системи

**Toast:** завжди за прапорцем `if (features.toastEnabled) toast.success('Збережено')`; при вимкненому — fallback `else setError(msg)` (inline error). `ToastContainer` монтується в `TopShell.tsx` — не підключати в новому layout.

**useDirtyForm** — захист від випадкового закриття. `const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({ enabled: features.unsavedGuardEnabled })`

- `onChange` → `markDirty()`; після збереження → `resetDirty()` (ОБОВ'ЯЗКОВО)
- `confirmClose()` → `Promise<boolean>`; `isDirtyRef` (useRef) для `beforeunload`, `isDirty` (useState) для рендеру

**useInlineEdit** — редагування у таблиці. `const inlineEdit = useInlineEdit({ enabled, onSave: async (rowId, field, value) => ... })`

- `inlineEdit.isEditing(row.id, 'field')` → `<InlineEditCell>` або `<InlineViewCell>`
- `commitEdit(v).catch(() => {})` — ЗАВЖДИ `.catch` бо re-throws після toast
- `<select>` → `defaultValue` (uncontrolled) — controlled `value` "відскакує" при in-flight save
- `savingRef` блокує подвійний коміт (blur + click)

**useBulkSelect** — множинний вибір. `const bulkSelect = useBulkSelect(data?.items ?? [])` — auto-prunes stale IDs при рефетч

- `indeterminate` → imperative через `useEffect + ref`, НЕ inline ref callback
- Bulk-мутації → `Promise.allSettled` (НЕ `Promise.all`); завжди `bulkSelect.clear()` + `load()`
- colSpan у loading/empty: `features.bulkActionsEnabled ? cols + 1 : cols`
- `useMemo` для `bulkActions` array

**useSavedFilters** — пресети фільтрів. `const { saved, save, remove } = useSavedFilters<MyFilters>('page-key')`

- SSR-safe: `useState([])` → гідратація у `useEffect` з localStorage
- `Array.isArray` guard при читанні — захист від corruption
- `pageKey` — унікальний per-page рядок (`'work-orders'`, `'inventory'`, `'employees'`)

**Hover-actions у рядках таблиці:**

- `group` на `<TableRow>`, кнопки: `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`
- `size="icon-sm"` для icon-only; `onClick={e => e.stopPropagation()}` на `<TableCell>`
- Trash2 у `{!isDeleted && ...}`; перед DELETE — `confirm({ variant: 'destructive' })`
- Навігація до деталей → `ExternalLink`; додаткові дії (Розцінити) → `Zap` зліва від Pencil
- Застосовується: work-orders (ExternalLink+Trash2), invoices/purchase-orders/stock-documents (Pencil+Trash2), catalog tabs (Pencil+Trash2/RotateCcw)

**NotificationCenter:** `const { add } = useNotifications(); add('success'|'error'|'warning', title, body)`

- `group` + `opacity-0 group-hover:opacity-100 focus:opacity-100` на кнопці delete
- `onKeyDown` на `role="button"` → guard `if (e.target !== e.currentTarget) return`

**SyncIndicator:** `window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'syncing' } }))` — `'idle'|'syncing'|'offline'|'error'`; wired у TopShell, показується коли `status !== 'idle'` або `lastSync !== null`

---

## Tailwind 4 — Canonical Syntax

### CSS var → canonical

```
// ❌ [var(--color-x)]  → ✅ (--color-x)  → ✅✅ canonical token (якщо є в @theme)
bg-[var(--color-background)]   → bg-(--color-background)  → bg-background
text-[var(--color-foreground)] → text-(--color-foreground) → text-foreground
border-[var(--color-border)]   → border-(--color-border)   → border-border
rounded-[var(--radius-lg)]     → rounded-(--radius-lg)     → rounded-lg
shadow-[var(--shadow-xs)]      → shadow-(--shadow-xs)      ← залишити (не є Tailwind token)
bg-[var(--kpi-bg)]             → bg-(--kpi-bg)             ← залишити (компонентна змінна)
```

### Tailwind токени (є в globals.css `@theme`)

| CSS var                    | Canonical                                 |
| -------------------------- | ----------------------------------------- |
| `--color-background`       | `bg-background`                           |
| `--color-foreground`       | `text-foreground`                         |
| `--color-muted-foreground` | `text-muted-foreground`                   |
| `--color-foreground-muted` | `text-foreground-muted`                   |
| `--color-border`           | `border-border`                           |
| `--color-border-hover`     | `border-border-hover` (hover:)            |
| `--color-primary`          | `bg-primary` / `text-primary`             |
| `--color-secondary`        | `bg-secondary`                            |
| `--color-destructive`      | `text-destructive` / `border-destructive` |
| `--color-success`          | `text-success`                            |
| `--color-muted`            | `bg-muted`                                |
| `--color-sidebar-bg`       | `bg-sidebar-bg`                           |
| `--color-sidebar-fg`       | `text-sidebar-fg`                         |
| `--color-sidebar-muted`    | `text-sidebar-muted`                      |
| `--color-sidebar-active`   | `bg-sidebar-active`                       |
| `--color-sidebar-hover`    | `bg-sidebar-hover` (hover:)               |
| `--color-sidebar-border`   | `border-sidebar-border`                   |
| `--color-brand-100`        | `ring-brand-100` / `bg-brand-100`         |
| `--radius`                 | `rounded`                                 |
| `--radius-sm`              | `rounded-sm`                              |
| `--radius-md`              | `rounded-md`                              |
| `--radius-lg`              | `rounded-lg`                              |
| `--radius-xl`              | `rounded-xl`                              |

### Pixel → Tailwind scale (px/4)

```
w-[52px]   → w-13      (52/4 = 13)
w-[216px]  → w-54      (216/4 = 54)
w-[420px]  → w-105     (420/4 = 105)
max-w-[360px] → max-w-90   (360/4 = 90)
top-[54px] → top-13.5  (54/4 = 13.5)
left-[40px] → left-10  (40/4 = 10)
h-[15px]   → h-3.75    (15/4 = 3.75)
w-[15px]   → w-3.75
```

### Інші canonical заміни

```
flex-shrink-0     → shrink-0
tracking-[0.05em] → tracking-wider
tracking-[0.08em] → tracking-widest
```

### Arbitrary value — парність дужок ОБОВ'ЯЗКОВА

Tailwind 4 JIT парсить `*-[...]` як arbitrary value. Незакрита `]` → клас **тихо НЕ генерується** (CSS не з'являється, помилки збірки немає). Перевіряй парність `[`/`]`; довгий клас винось у змінну (`const ringErr = 'focus:ring-[hsl(0_86%_93%)]'`); `/sto-review` grep'ає незакриті дужки.

```tsx
// ❌ Невидима помилка — фокус-ring не з'являється
hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)',

// ✅ Закрита дужка — клас працює
hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)]',
```

### Blob URL — `revokeObjectURL` тільки через setTimeout

`URL.revokeObjectURL(url)` синхронно після `a.click()` зриває завантаження у Chromium (URL відкликається до fetch blob'а).

```tsx
// ❌ Зриває .xlsx завантаження в Chromium
const url = URL.createObjectURL(blob);
a.href = url;
a.download = 'file.xlsx';
a.click();
URL.revokeObjectURL(url);

// ✅ Дай браузеру час почати fetch
const url = URL.createObjectURL(blob);
a.href = url;
a.download = 'file.xlsx';
a.click();
setTimeout(() => URL.revokeObjectURL(url), 100);
```

---

## Optimistic UI — миттєвий відгук без очікування API

```typescript
// ❌ Блокуючий UX — кнопка disabled, чекаємо відповіді
const handleTransition = async (id: string, status: string) => {
  setSaving(id);
  await apiFetch(`/work-orders/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
  await load();
  setSaving(null);
};

// ✅ Optimistic update — відразу показуємо новий стан, rollback при помилці
const handleTransition = async (id: string, newStatus: string) => {
  const prev = items.find(i => i.id === id);
  // 1. Одразу оновлюємо UI
  setItems(items => items.map(i => (i.id === id ? { ...i, status: newStatus } : i)));
  try {
    await apiFetch(`/work-orders/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status: newStatus }),
    });
    // 2. Refetch для консистентності (side-effects на сервері)
    await load();
  } catch (e) {
    // 3. Rollback при помилці
    setItems(items => items.map(i => (i.id === id ? { ...i, status: prev!.status } : i)));
    if (features.toastEnabled)
      toast.error(`Помилка: ${e instanceof Error ? e.message : 'Невідома помилка'}`);
  }
};
```

**Правила Optimistic UI:**

- Зберігати `prev` state ПЕРЕД мутацією для rollback
- `setItems` з functional updater (не closure value) — щоб не затерти паралельні зміни
- Завжди `load()` після успіху — side-effects на сервері можуть змінити інші поля
- НЕ застосовувати до: фінансових операцій, FSM-переходів з критичними side-effects (WRITEOFF, CHARGE)

---
