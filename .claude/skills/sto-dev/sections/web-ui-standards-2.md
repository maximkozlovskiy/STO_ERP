# sto-dev — web-ui-standards-2

> Частина скіла `sto-dev`; винесено дослівно, щоб кожен файл влазив в один Read.

## §16 SharedStatusConstants — єдине місце для статусів

`STATUS_LABELS`, `STATUS_BADGE`, `PRIORITY_LABELS` — тільки в `packages/shared/src/constants/statuses.ts`. `Record<WorkOrderStatus, string>` → compile-error при пропущеному статусі. `import { WO_STATUS_LABELS, WO_STATUS_BADGE } from '@sto/shared'` — НЕ inline у page.tsx.

---

## §17 usePaginatedList — generic API hook factory

Новий list-хук: `return usePaginatedList<WorkOrder, WorkOrdersFilter>('/work-orders', filters)` — НЕ вручну URLSearchParams boilerplate. Файл: `apps/web/src/hooks/api/usePaginatedList.ts`

---

## §19 FSMButtons — shared компонент FSM-переходів

> **Правило:** Кнопки FSM-переходів не рендеряться inline у page.tsx. Використовується `<FSMButtons>`. Файл: `apps/web/src/components/ui/fsm-buttons.tsx`

```typescript
// ❌ Дублювання логіки у кожній сторінці
{STATUS_TRANSITIONS[item.status]?.map(s => (
  <Button key={s} variant={s === 'CANCELLED' ? 'destructive' : 'outline'} onClick={() => handleTransition(s)}>
    {TRANSITION_LABELS[s]}
  </Button>
))}
```

```tsx
// ✅ apps/web/src/components/ui/fsm-buttons.tsx
<FSMButtons
  status={wo.status}
  transitions={WO_FSM_TRANSITIONS}
  labels={WO_TRANSITION_LABELS}
  onTransition={handleTransition}
  loading={saving}
/>
```

---

## §20 useApiMutation — wrapper для мутацій

Нова форма/дія: `const { mutate, saving, error } = useApiMutation(fn, { onSuccess: load, successMsg: 'Збережено' })` — НЕ вручну saving/error state + try/catch. Файл: `apps/web/src/hooks/useApiMutation.ts`

---

## §21 Shared Zod validators

> **Правило:** Валідаційні правила (email, телефон, IBAN) не пишуться regex inline. Є `@sto/shared` validators. Файл-джерело правди: `packages/shared/src/schemas/validators.ts`

```typescript
// packages/shared/src/schemas/validators.ts
export const phoneUaSchema = z.string().regex(/^\+380\d{9}$/, 'Невірний формат телефону');
export const emailSchema = z.string().email('Невірний email');
export const ibanUaSchema = z.string().regex(/^UA\d{27}$/, 'Невірний IBAN');

// У фронт-формі:
import { phoneUaSchema } from '@sto/shared';
const schema = z.object({ phone: phoneUaSchema });

// На бекенді (DTO):
import { PHONE_UA_REGEX } from '@sto/shared';
@Matches(PHONE_UA_REGEX, { message: 'Невірний формат телефону' })
phone: string;
```

---

## §22 useApiError — централізований handler помилок

`const { error, handleError, clearError } = useApiError()` — НЕ вручну `useState('')` + `catch(e) { setError(e.message) }`. Файл: `apps/web/src/hooks/useApiError.ts`

---

## §23 TableContainer — контейнер таблиці зі sticky-шапкою

**ЗАВЖДИ** загортати `<Table>` у `<TableContainer>` замість inline div.

```tsx
// ❌ Заборонено
<div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
  <Table>...</Table>
</div>;

// ✅ Правильно
import { TableContainer } from '@/components/ui/table-container';

<div className="flex flex-1 min-h-0">
  <TableContainer>
    <Table>
      <TableHeader>...</TableHeader>
      <TableBody>...</TableBody>
    </Table>
  </TableContainer>
</div>;
```

### Чому

`TableContainer` додає клас `table-scroll-container`, який вирішує два візуальних баги шапки (CSS у globals.css). ❌ Без `TableContainer` — справа від шапки білий простір (видно фон контейнера). ✅ З `TableContainer` — фон за скролбаром збігається з кольором thead.

```css
:root {
  --table-thead-h: 33px;
}
/* 1. Трек скролбара починається нижче шапки */
.table-scroll-container::-webkit-scrollbar-track {
  margin-top: var(--table-thead-h);
}
/* 2. Гатер скролбара = колір шапки, рядки перекривають до surface */
.table-scroll-container {
  background-color: var(--color-secondary);
}
.table-scroll-container tbody {
  background-color: var(--color-surface);
}
```

### Props

| Prop             | Default | Опис                                        |
| ---------------- | ------- | ------------------------------------------- |
| `constrainWidth` | `true`  | Додає `min-w-0` для правильного flex-shrink |
| `className`      | —       | Перевизначення стилів                       |

```tsx
{/* Без min-w-0 (рідко, тільки без DetailPanel поряд) */}
<TableContainer constrainWidth={false}>

{/* Кастомний стиль */}
<TableContainer className="rounded-none border-0">
```

**Нестандартна висота шапки** (двохрядкова, інший padding) → перевизнач CSS-змінну на контейнері:

```tsx
<TableContainer style={{ '--table-thead-h': '52px' } as React.CSSProperties}>
```

---

## §24 — EntityPickerField + \*EditModal: стандарт поля-посилання

> **Правило:** будь-яке поле форми що посилається на інший об'єкт (контрагент, товар, наряд, співробітник) **ЗАВЖДИ** через `EntityPickerField` + `*EditModal` + `SearchPickerModal`. Старий патерн «велика кнопка з іконкою Search всередині» — **заборонений**.

### §24.1 — EntityPickerField — єдиний UI-контрол для reference-поля

```tsx
// apps/web/src/components/ui/entity-picker-field.tsx
interface EntityPickerFieldProps {
  display: string; // текст обраного запису або ''
  placeholder?: string; // 'Обрати...'
  disabled?: boolean;
  hidePick?: boolean; // true =ховати кнопку ... (read-only режим)
  onOpenDetail?: () => void; // undefined → кнопка 🔍 disabled
  onPick: () => void; // відкрити SearchPickerModal
  onClear: () => void; // очистити вибір
}
```

**Візуальна схема:**

```
[ Іван Коваль                   × 🔍 … ]
  ↑ display або placeholder     ↑ ↑ ↑
                                │ │ └─ onPick → SearchPickerModal
                                │ └─── onOpenDetail → *EditModal (disabled якщо нема)
                                └───── onClear (hidden якщо display = '')
```

**Кнопка `UserPlus` / `FilePlus` (створення нового)** — ЗОВНІ поля, праворуч:

```tsx
<div className="flex items-center gap-1">
  <div className="flex-1 min-w-0">
    <EntityPickerField ... />
  </div>
  <Button variant="outline" size="sm" onClick={openCreateWizard} className="h-9 w-9 p-0 shrink-0">
    <UserPlus className="h-4 w-4" />
  </Button>
</div>
```

### §24.2 — \*EditModal — стандарт компонента редагування об'єкта

Кожна сутність через лупу → окремий `*EditModal.tsx` у `apps/web/src/components/ui/`. Props: `{ open, entity: XxxForModal | null, onClose, onSaved }` — `null` = режим створення.

Внутрішня структура:

1. `useEffect([open, entity?.id])` — синхронізація форми, `dirty.resetDirty()`, `setError('')`
2. `useEffect([open, entity?.id])` — завантаження дочірніх з race guard (`reqRef.current`)
3. `handleClose` → `dirty.confirmClose()` перед `onClose()`
4. `<DirtyConfirmDialog {...dirty.dialogProps} />` + `<ConfirmDialog {...confirmProps} />` у return

### §24.3 — Повний патерн: reference-поле у формі

```ts
// State
const [cpPickerOpen, setCpPickerOpen] = useState(false);
const [cpDetailOpen, setCpDetailOpen] = useState(false);
const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);

// lazy fetch
const openCpDetail = useCallback(async () => {
  if (!form.counterpartyId) return;
  const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.counterpartyId}`);
  setCpDetailData(cp); setCpDetailOpen(true);
}, [form.counterpartyId]);

// JSX
<EntityPickerField
  display={form.counterpartyDisplay} placeholder="Обрати контрагента..."
  onOpenDetail={form.counterpartyId ? openCpDetail : undefined}
  onPick={() => setCpPickerOpen(true)}
  onClear={() => setForm(f => ({ ...f, counterpartyId: '', counterpartyDisplay: '' }))}
/>
<SearchPickerModal<CpItem> open={cpPickerOpen} onClose={() => setCpPickerOpen(false)}
  title="Оберіть контрагента" selectedId={form.counterpartyId}
  fetchItems={fetchCpItems}
  onSelect={item => { setForm(f => ({ ...f, counterpartyId: item.id, counterpartyDisplay: item.primary })); setCpPickerOpen(false); }}
/>
<CounterpartyEditModal open={cpDetailOpen} counterparty={cpDetailData}
  onClose={() => setCpDetailOpen(false)}
  onSaved={u => { setForm(f => ({ ...f, counterpartyDisplay: u.companyName ?? '' })); setCpDetailOpen(false); }}
/>
```

### §24.4 — Реєстр \*EditModal компонентів

| Компонент                  | Файл                              | Відкривається для                  |
| -------------------------- | --------------------------------- | ---------------------------------- |
| `CounterpartyEditModal`    | `ui/CounterpartyEditModal.tsx`    | контрагент (клієнт / постачальник) |
| `GoodEditModal`            | `ui/GoodEditModal.tsx`            | товар / запчастина                 |
| `EmployeeEditModal`        | `ui/EmployeeEditModal.tsx`        | співробітник                       |
| `WorkOrderAddLineModal`    | `ui/WorkOrderAddLineModal.tsx`    | додавання роботи до наряду         |
| `WorkOrderAddPartModal`    | `ui/WorkOrderAddPartModal.tsx`    | додавання запчастини до наряду     |
| `PurchaseOrderCreateModal` | `ui/PurchaseOrderCreateModal.tsx` | замовлення постачальнику           |
| `InvoiceCreateModal`       | `ui/InvoiceCreateModal.tsx`       | рахунок                            |
| `StockDocumentCreateModal` | `ui/StockDocumentCreateModal.tsx` | документ складу                    |

> При додаванні нової сутності — додай рядок у цю таблицю.

### §24.5 — Заборонені патерни

```tsx
// ❌ Пряме посилання через window.open або router.push з форми
onClick={() => window.open(`/counterparties/${id}`, '_blank')}
onClick={() => router.push(`/counterparties/${id}`)}
// ✅ Замість цього — openDetail() → *EditModal

// ❌ Велика кнопка з іконкою Search всередині (старий патерн)
<button onClick={() => setPickerOpen(true)} className="flex-1 flex items-center justify-between ...">
  <span>{display || 'Обрати...'}</span>
  <Search className="h-3.5 w-3.5" />
</button>
// ✅ Замість цього — EntityPickerField

// ❌ Inline форма редагування > 5 полів у page.tsx
<Modal open={editModal} ...>
  <Input label="Назва" ... />
  <Input label="Телефон" ... />
  ...300 рядків JSX...
</Modal>
// ✅ Виноси в окремий *EditModal компонент

// ❌ detailHref prop (застарілий, видалений)
<EntityPickerField detailHref="/counterparties/123" />
// ✅ onOpenDetail callback
<EntityPickerField onOpenDetail={form.counterpartyId ? openCpDetail : undefined} />
```

### §24.6 — Checklist для нового reference-поля

```
[ ] Поле відображається через EntityPickerField, не через кастомну кнопку
[ ] Кнопка … відкриває SearchPickerModal для пошуку і вибору
[ ] Кнопка 🔍 disabled якщо нема вибраного (onOpenDetail = undefined)
[ ] Кнопка 🔍 робить lazy fetch + відкриває *EditModal
[ ] Кнопка × очищає вибір (hidden якщо display = '')
[ ] Якщо є дія "створити новий" — кнопка UserPlus/FilePlus ЗОВНІ поля
[ ] *EditModal для цього типу об'єкта існує в реєстрі §24.4
[ ] onSaved оновлює display у батьківській формі
[ ] TypeScript 0 errors
```

---

## §26 Settings Tab — стандарт вкладки налаштувань

### Структура файлу

```
apps/web/src/app/(app)/settings/
├── page.tsx          ← реєстрація вкладки (Tab type + TABS array + рендер)
├── shared.ts         ← OrgSettings / BranchSettings типи
└── XxxTab.tsx        ← окремий файл на кожну вкладку
```

**Реєстрація вкладки в `page.tsx`:**

```typescript
// 1. dynamic import (ssr: false — всі вкладки налаштувань)
const DocumentsTab = dynamic(() => import('./DocumentsTab'), { ssr: false });

// 2. розширити Tab union
type Tab = 'numbers' | 'workdays' | 'documents' | ...;

// 3. додати до TABS array (порядок = порядок у UI)
{ key: 'documents', label: 'Налаштування документів' },

// 4. рендер
{tab === 'documents' && <DocumentsTab />}
```

### Шаблон вкладки (XxxTab.tsx)

```tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type OrgSettings } from './shared';

// Toggle — локальний компонент (не виноси в shared, кожна вкладка незалежна)
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-border',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export default function XxxTab() {
  const features = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(setOrgSettings)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'),
      );
  }, []);

  const save = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ fieldA: orgSettings.fieldA }),
      });
      setOrgSettings(updated);
      if (features.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-6">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Назва секції</h2>

        {/* Рядок налаштування з Toggle */}
        <div
          className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0"
          title="Розширений опис для tooltip при наведенні"
        >
          <div>
            <p className="text-sm font-medium text-foreground">Назва налаштування</p>
            <p className="text-xs text-muted-foreground mt-0.5">Короткий опис під назвою</p>
          </div>
          <Toggle
            checked={orgSettings.fieldA ?? false}
            onChange={v => setOrgSettings({ ...orgSettings, fieldA: v })}
          />
        </div>
      </section>

      <div>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Збереження...' : 'Зберегти'}
        </Button>
      </div>
    </div>
  );
}
```

### Правила

```
✅ Toggle (синій перемикач) — для boolean налаштувань
✅ title на рядку div — tooltip при наведенні з повним описом
✅ Короткий опис під назвою (text-xs text-muted-foreground)
✅ border-b border-border last:border-0 — розділювач між рядками
✅ if (!orgSettings) return null — не рендерити поки не завантажено
✅ features.toastEnabled — перевірка перед toast
✅ PATCH тільки змінені поля (не весь об'єкт)

❌ НЕ input type="checkbox" для boolean налаштувань — тільки Toggle
❌ НЕ зберігати автоматично onChange — завжди кнопка "Зберегти"
❌ НЕ виносити Toggle у shared — локальний компонент у файлі вкладки
```

### Додавання нового boolean поля

1. `schema.prisma` → `OrganisationSettings`: `newField Boolean @default(true/false)`
2. `db push` (dev) або міграція (prod)
3. `settings.dto.ts` → `UpdateOrganisationSettingsDto` + `OrganisationSettingsResponseDto`
4. `settings.service.ts` → параметр inline-типу `mapOrganisationSettings()` + return об'єкт
5. `settings/shared.ts` → `OrgSettings` тип
6. Новий або існуючий `XxxTab.tsx` → Toggle

---
