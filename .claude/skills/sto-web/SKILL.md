---
name: sto-web
description: >
  Create Next.js 15 pages, components, and API hooks for STO ERP web app (Reception + Admin). Use when the user says "зроби сторінку", "компонент", "веб інтерфейс", "фронтенд", "таблиця", "форма", or implementing the web UI layer. Produces production-ready Next.js code following STO ERP conventions with shadcn/ui + TanStack Query.
model: claude-sonnet-4-6
---

# sto-web — Next.js 15 Web UI Skill

## Before Starting

1. Read `sto-context` — understand domain and roles
2. Check existing similar page/component for patterns
3. Confirm API endpoint exists (or run `sto-backend` first)

---

## App Router Structure

```
apps/web/src/
├── app/
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx              ← sidebar + navbar
│   │   ├── work-orders/
│   │   │   ├── page.tsx            ← list page
│   │   │   ├── [id]/page.tsx       ← detail page
│   │   │   └── new/page.tsx        ← create page
│   │   ├── vehicles/
│   │   ├── inventory/
│   │   ├── settlements/
│   │   └── reports/
├── components/
│   ├── ui/                         ← shadcn/ui components (don't edit)
│   ├── work-orders/
│   │   ├── WorkOrderTable.tsx
│   │   ├── WorkOrderForm.tsx
│   │   └── WorkOrderStatusBadge.tsx
│   └── shared/
│       ├── DataTable.tsx           ← TanStack Table wrapper
│       ├── PageHeader.tsx
│       └── ConfirmDialog.tsx
├── lib/
│   ├── api/
│   │   ├── client.ts               ← axios instance with auth interceptor
│   │   ├── work-orders.ts          ← API functions
│   │   └── query-keys.ts           ← TanStack Query key factories
│   ├── hooks/
│   │   ├── useWorkOrders.ts        ← TanStack Query hooks
│   │   └── useAuth.ts
│   └── utils.ts
```

---

## API Client Pattern

```typescript
// lib/api/client.ts
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// lib/api/query-keys.ts
export const queryKeys = {
  workOrders: {
    all: (orgId: string) => ['work-orders', orgId] as const,
    list: (orgId: string, filters: object) => ['work-orders', orgId, 'list', filters] as const,
    detail: (orgId: string, id: string) => ['work-orders', orgId, id] as const,
  },
  vehicles: {
    all: (orgId: string) => ['vehicles', orgId] as const,
    byCounterparty: (orgId: string, counterpartyId: string) => ['vehicles', orgId, 'by-counterparty', counterpartyId] as const,
  },
};
```

---

## TanStack Query Hooks Pattern

```typescript
// lib/hooks/useWorkOrders.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { queryKeys } from '../api/query-keys';

export function useWorkOrders(page = 1, limit = 20) {
  return useQuery({
    queryKey: queryKeys.workOrders.list(orgId, { page, limit }),
    queryFn: () => apiClient.get('/work-orders', { params: { page, limit } }).then(r => r.data),
    staleTime: 30_000,
  });
}

export function useCreateWorkOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateWorkOrderDto) =>
      apiClient.post('/work-orders', dto).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    },
    onError: (error: AxiosError<{ message: string }>) => {
      toast.error(error.response?.data?.message ?? 'Помилка');
    },
  });
}

export function useTransitionWorkOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/work-orders/${id}/status`, { status }).then(r => r.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    },
  });
}
```

---

## List Page Pattern

```typescript
// app/(dashboard)/work-orders/page.tsx
'use client';
import { useState } from 'react';
import { useWorkOrders } from '@/lib/hooks/useWorkOrders';
import { DataTable } from '@/components/shared/DataTable';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { columns } from '@/components/work-orders/columns';
import Link from 'next/link';

export default function WorkOrdersPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useWorkOrders(page);

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Замовлення-наряди"
        actions={
          <Button asChild>
            <Link href="/work-orders/new">Новий наряд</Link>
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        isLoading={isLoading}
      />
    </div>
  );
}
```

---

## Form Pattern (React Hook Form + Zod)

```typescript
// components/work-orders/WorkOrderForm.tsx
'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useCreateWorkOrder } from '@/lib/hooks/useWorkOrders';
import { createWorkOrderSchema } from '@sto/shared';

type FormValues = z.infer<typeof createWorkOrderSchema>;

export function WorkOrderForm() {
  const { mutate, isPending } = useCreateWorkOrder();

  const form = useForm<FormValues>({
    resolver: zodResolver(createWorkOrderSchema),
    defaultValues: { description: '' },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => mutate(data))} className="space-y-4">
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Опис</FormLabel>
              <FormControl>
                <Input placeholder="Опис робіт" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Збереження...' : 'Створити наряд'}
        </Button>
      </form>
    </Form>
  );
}
```

---

## TanStack Table Columns Pattern

```typescript
// components/work-orders/columns.tsx
import { ColumnDef } from '@tanstack/react-table';
import { WorkOrderStatusBadge } from './WorkOrderStatusBadge';
import { formatCurrency, formatDate } from '@/lib/utils';

export const columns: ColumnDef<WorkOrderResponse>[] = [
  { accessorKey: 'number', header: 'Номер', cell: ({ row }) => (
    <a href={`/work-orders/${row.original.id}`} className="font-medium hover:underline">
      {row.getValue('number')}
    </a>
  )},
  { accessorKey: 'status', header: 'Статус', cell: ({ row }) => (
    <WorkOrderStatusBadge status={row.getValue('status')} />
  )},
  { accessorKey: 'vehicle', header: 'Авто', cell: ({ row }) => {
    const v = row.original.vehicle;
    return `${v.make} ${v.model} · ${v.licensePlate}`;
  }},
  { accessorKey: 'counterparty', header: 'Клієнт', cell: ({ row }) => {
    const c = row.original.counterparty;
    return `${c.firstName} ${c.lastName}`;
  }},
  { accessorKey: 'totalAmount', header: 'Сума', cell: ({ row }) => formatCurrency(row.getValue('totalAmount')) },
  { accessorKey: 'createdAt', header: 'Дата', cell: ({ row }) => formatDate(row.getValue('createdAt')) },
];
```

---

## Checklist

- [ ] Page uses `'use client'` only when needed (prefer server components for static layouts)
- [ ] API calls go through TanStack Query hooks (no raw fetch in components)
- [ ] Forms use React Hook Form + Zod schema from `@sto/shared`
- [ ] Error states handled (toast + form field errors)
- [ ] Loading states shown (skeleton or spinner)
- [ ] Role-based rendering: wrap admin-only sections with `<RoleGuard roles={[...]}/>`
- [ ] Tables use DataTable wrapper (consistent pagination)
- [ ] `pnpm --filter @sto/web build` passes
- [ ] toast.X завжди за `if (features.toastEnabled)` + fallback `setError`
- [ ] Bulk mutations через `Promise.allSettled` — ніколи `Promise.all`
- [ ] `indeterminate` через `useRef` + `useEffect`, не inline ref callback
- [ ] `useSavedFilters` init `[]`, гідратація у `useEffect`, `Array.isArray` guard

---

## Ukrainian UI Standards for Web

### Ukrainian Locale in Next.js
```typescript
// app/layout.tsx
export const metadata = { title: 'STO ERP' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
```

### Ukrainian UI String Constants
```typescript
// packages/shared/src/constants/ui-strings.ts
export const UI = {
  actions: {
    save:    'Зберегти',
    cancel:  'Скасувати',
    delete:  'Видалити',
    edit:    'Редагувати',
    create:  'Створити',
    confirm: 'Підтвердити',
    back:    'Назад',
    search:  'Пошук',
    filter:  'Фільтр',
    export:  'Експорт',
    print:   'Друк',
  },
  status: {
    loading: 'Завантаження...',
    saving:  'Збереження...',
    empty:   'Нічого не знайдено',
    error:   'Сталася помилка',
  },
  workOrder: {
    title:   'Замовлення-наряди',
    new:     'Новий наряд',
    number:  'Номер наряду',
    status:  'Статус',
    client:  'Клієнт',
    vehicle: 'Автомобіль',
    amount:  'Сума',
    date:    'Дата',
  },
} as const;
```

### Date/Currency Display Components
```tsx
// components/shared/FormatCurrency.tsx
export function FormatCurrency({ amount }: { amount: number }) {
  return (
    <span>
      {amount.toLocaleString('uk-UA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}{' '}
      ₴
    </span>
  );
}

// components/shared/FormatDate.tsx
export function FormatDate({ date }: { date: string | Date }) {
  return (
    <time dateTime={new Date(date).toISOString()}>
      {new Date(date).toLocaleDateString('uk-UA')}
    </time>
  );
}
```

### Ukrainian Form Placeholders & Labels Pattern
```tsx
// Always use Ukrainian in all form elements
<FormField name="phone" render={({ field }) => (
  <FormItem>
    <FormLabel>Номер телефону</FormLabel>
    <FormControl>
      <Input placeholder="+38 (067) 123-45-67" {...field} />
    </FormControl>
    <FormMessage /> {/* Zod validation messages are Ukrainian */}
  </FormItem>
)} />
```

### Ukrainian shadcn/ui Table Columns Pattern
```typescript
// Always Ukrainian headers
export const workOrderColumns: ColumnDef<WorkOrderResponse>[] = [
  { accessorKey: 'number',      header: 'Номер' },
  { accessorKey: 'status',      header: 'Статус' },
  { accessorKey: 'vehicle',     header: 'Автомобіль' },
  { accessorKey: 'counterparty',header: 'Клієнт' },
  { accessorKey: 'totalAmount', header: 'Сума', cell: ({ row }) => <FormatCurrency amount={row.getValue('totalAmount')} /> },
  { accessorKey: 'createdAt',   header: 'Дата',  cell: ({ row }) => <FormatDate date={row.getValue('createdAt')} /> },
];
```

### Ukrainian Toast Notifications
```typescript
// ✅ Завжди перевіряй прапорець + fallback
const features = useUiFeatures();
try {
  await apiFetch('/work-orders', { method: 'POST', body: JSON.stringify(data) });
  if (features.toastEnabled) toast.success('Наряд створено');
  setModal(false);
} catch (e) {
  const msg = e instanceof Error ? e.message : 'Помилка';
  if (features.toastEnabled) toast.error(msg);
  else setError(msg);  // ❌ НЕ викидай помилку мовчки
}

// ✅ Типові повідомлення (Ukrainian):
toast.success('Збережено');
toast.success(`Фільтр "${name}" збережено`);
toast.success(`Скасовано ${n} нарядів`);
toast.warning(`Скасовано ${ok} з ${total}. ${total - ok} не змінено`);  // bulk partial
toast.warning('Залишок нижче мінімального рівня');
toast.error(`Помилка: ${e.message}`);
toast.info('Синхронізацію завершено');
```

---

## UX Hooks — довідник

### useUiFeatures
```typescript
import { useUiFeatures, invalidateUiFeaturesCache } from '@/hooks/useUiFeatures';
const features = useUiFeatures();  // module-level cache, одна мережа-запит на сесію
invalidateUiFeaturesCache();       // викликати після збереження налаштувань
```
Endpoint: `GET /settings/ui-features` — доступний усім авторизованим ролям.

### useDirtyForm
```typescript
import { useDirtyForm } from '@/hooks/useDirtyForm';
const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({
  enabled: features.unsavedGuardEnabled,
});
// onChange: markDirty()
// onClose button: if (await confirmClose()) { resetDirty(); closeModal(); }
// after save: resetDirty()
```

### useInlineEdit
```typescript
import { useInlineEdit } from '@/hooks/useInlineEdit';
const inlineEdit = useInlineEdit({ enabled: features.inlineEditEnabled, onSave });
// isEditing(id, field), startEdit(id, field, value), commitEdit(value), cancelEdit
// InlineEditCell + InlineViewCell з '@/components/ui/inline-edit-cell'
// commitEdit ЗАВЖДИ: void inlineEdit.commitEdit(v).catch(() => {})
```

### useBulkSelect
```typescript
import { useBulkSelect } from '@/hooks/useBulkSelect';
const bulkSelect = useBulkSelect(data?.items ?? []);
// { selected, toggle, toggleAll, clear, isSelected, allSelected, someSelected, count }
// Автоматично прибирає stale IDs при зміні items (пагінація / фільтрація)
```
Шаблон indeterminate:
```typescript
const selectAllRef = useRef<HTMLInputElement>(null);
useEffect(() => {
  if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
}, [bulkSelect.someSelected]);
```

### useSavedFilters
```typescript
import { useSavedFilters } from '@/hooks/useSavedFilters';
interface MyFilters extends Record<string, unknown> { status: string; }
const { saved, save, remove } = useSavedFilters<MyFilters>('page-key');
const preset = save('Назва', filters);  // повертає { id, name, filters }
```

### useKeyboardShortcut
```typescript
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
useKeyboardShortcut('k', () => setPaletteOpen(true), { enabled: features.commandPaletteEnabled, ctrl: true });
// SHIFT_ALIAS map: '?' → '/' (layout-independent)
// null guard на e.target перед перевіркою isInputEl
```

### Windows Dev Notes
```powershell
# Hot reload works correctly on Windows with Next.js 15
pnpm --filter @sto/web dev      # http://localhost:3001
# If hot reload is slow — add to next.config.ts:
# experimental: { turbo: {} }
```
