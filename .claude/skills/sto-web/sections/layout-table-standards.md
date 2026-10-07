# sto-web — layout-table-standards

> Частина скіла `sto-web`; винесено дослівно, щоб кожен файл влазив в один Read.

## Стандарт layout довідника (ОБОВ'ЯЗКОВО дотримуватись)

> **Еталон:** `apps/web/src/app/(app)/counterparties/page.tsx`  
> Всі довідникові сторінки (список + фільтри + таблиця) МАЮТЬ виглядати однаково.  
> Якщо правиш існуючу сторінку — звір з цим стандартом і виправ відступи.

### Ключові правила

| Елемент              | ✅ Правильно                                                                                                        | ❌ Неправильно                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| page-header          | `<div class="page-header"><div><h1>...</h1></div></div>`                                                            | h1 напряму без `<div>` обгортки; кнопки в header |
| Кнопки в шапці       | усі кнопки в рядку фільтрів (не в page-header)                                                                      | кнопка "+ Додати" в page-header                  |
| Вкладки              | `gap-0 -mx-6 px-6 py-2.5 text-[13px]` (без mb!)                                                                     | `gap-1 mb-4 py-2 text-sm`                        |
| Пошук                | `<Input leftElement={<Search />}>`                                                                                  | кастомний `<input>` з абсолютною іконкою         |
| Eye кнопка           | `size="icon-sm"`, `border-primary text-primary` при active                                                          | `size="sm"`, текст у кнопці, `border-warning`    |
| Кнопка "+ Об'єкт"    | без `size=`, конкретна назва ("Філія", "Контрагент")                                                                | `size="sm"`, загальне "Додати"                   |
| Права група          | `ml-auto flex items-center gap-2` всередині flex filters                                                            | окремий toolbar div над таблицею                 |
| Відступ tabs→filters | `gap: 0.5rem` (page-fill) + `py-2.5` кнопок = ~16px вигляд                                                          | `mb-4`, `mb-5`, `pt-4` на tabs або filters div   |
| Видалені рядки       | `opacity-60` + badge "видалено", кнопки дій приховані                                                               | `opacity-50`, червоний фон, кнопки залишені      |
| Видалені у FK select | тільки активні: `.filter(b => !b.deletedAt)`                                                                        | всі записи включно з deleted                     |
| Таблиця-обгортка     | `flex flex-1 min-h-0` → всередині `flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl` | `overflow-hidden rounded-xl` без flex обгортки   |
| Рядок таблиці        | `group transition-colors`, кнопки дій `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`                 | кнопки дій завжди видимі                         |
| Кнопки дій у рядку   | `size="icon-sm"`, Pencil + Trash2, `onClick={e => e.stopPropagation()}` на комірці                                  | `size="sm"`, текстові кнопки                     |
| Назва у рядку        | `text-[13px] font-medium text-primary` (клікабельне) або `text-foreground` (не клікабельне)                         | `font-medium` без кольору                        |
| Email/phone підрядок | `text-[12px] text-muted-foreground mt-0.5` під назвою                                                               | окрема колонка                                   |
| Spinner у таблиці    | `py-12 text-center` + `<Spinner size="md" />` в `flex justify-center`                                               | `py-10`, `size="lg"`                             |
| EmptyState           | `colSpan=... className="p-0"` + `<EmptyState icon={...} size="sm" />`                                               | без `p-0`, без `icon`                            |
| Пагінація            | `<Pagination page={page} totalPages={totalPages} onChange={setPage} />` після `</div>` table-wrapper                | кнопки Prev/Next вручну                          |

---

## Стандарт таблиці (ОБОВ'ЯЗКОВО)

> **Еталон:** `apps/web/src/app/(app)/counterparties/page.tsx` + `employees/page.tsx`

### Контейнер таблиці

**ЗАВЖДИ** використовувати `TableContainer` замість inline div:

```tsx
import { TableContainer } from '@/components/ui/table-container';

{
  /* Table + DetailPanel (якщо є) */
}
<div className="flex flex-1 min-h-0">
  <TableContainer>{/* Table йде сюди */}</TableContainer>
  {/* DetailPanel якщо є */}
</div>;
```

❌ Не робити inline div:

```tsx
<div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
```

✅ Завжди `TableContainer`:

```tsx
<TableContainer>
```

**Чому:** `TableContainer` автоматично вирішує два баги через клас `table-scroll-container`:

- Трек скролбара починається нижче шапки (`--table-thead-h: 33px` margin-top на `::-webkit-scrollbar-track`)
- Область скролбара (5px справа від thead) зафарбована в `bg-secondary` — збігається з кольором шапки; `tbody` перекриває до `bg-surface`
- Єдина точка зміни стилів для всіх таблиць

**Кастомні класи** — через `className` prop:

```tsx
<TableContainer className="gap-3">  {/* inventory має gap-3 на flex-батьку */}
```

**Без `min-w-0`** (рідко, тільки якщо немає DetailPanel поруч):

```tsx
<TableContainer constrainWidth={false}>
```

---

### Пагінація на бекенді — стандарт

```typescript
// Hook — повертає { items, total }
return useQuery<{ items: T[]; total: number }>({...});

// Сторінка
const LIMIT = 20;
const [page, setPage] = useState(1);
const { data } = useMyResource({ page, limit: LIMIT, ... });
const items = data?.items ?? [];
const totalPages = Math.ceil((data?.total ?? 0) / LIMIT);

// Скидати page при зміні фільтрів:
onChange={e => { setFilter(e.target.value); setPage(1); setActiveSavedFilterId(null); }}

// Бекенд — findAll повертає { items, total } через $transaction:
const [items, total] = await prisma.$transaction([
  prisma.resource.findMany({ where, take: limit, skip: (page-1)*limit }),
  prisma.resource.count({ where }),
]);
return { items: items.map(toDto), total };
```

---
