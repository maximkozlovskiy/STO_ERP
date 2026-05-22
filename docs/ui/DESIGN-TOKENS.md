# STO ERP — UI Дизайн-система

> Стандарти для web (Next.js + shadcn/ui + Tailwind 4) та mobile (Expo + React Native).  
> Весь інтерфейс — **українською мовою (кирилиця)**.  
> Базова тема — **світла** (light). Темна тема — не реалізована в MVP.

---

## 1. Кольорова палітра

### Основні кольори (CSS змінні / Tailwind tokens)

```css
/* Tailwind 4 — apps/web/src/app/globals.css */
@theme {
  /* Бренд / Навігаційна оболонка */
  --color-brand:          #1E3A5F;  /* Топбар, активні елементи навігації */
  --color-brand-hover:    #16304F;
  --color-brand-accent:   #3B82F6;  /* Акцент: зірочки, іконки в мега-меню */
  --color-brand-accent-light: #EFF6FF; /* Фон активної закладки */
  --color-brand-accent-border: #DBEAFE; /* Рамка активної закладки */

  /* Основна дія (кнопки, посилання) */
  --color-primary:        #1E3A5F;  /* = brand, кнопка "Зберегти" / "Новий наряд" */
  --color-primary-hover:  #16304F;
  --color-primary-light:  #EFF6FF;

  --color-success:        #16A34A;  /* Завершено, оплачено */
  --color-success-light:  #F0FDF4;

  --color-warning:        #D97706;  /* На утриманні, очікує */
  --color-warning-light:  #FFFBEB;

  --color-danger:         #DC2626;  /* Помилки, скасовано */
  --color-danger-light:   #FFF1F2;

  --color-info:           #1E40AF;  /* Інформаційний стан */
  --color-info-light:     #EFF6FF;

  /* Нейтральна шкала */
  --color-neutral-50:     #F5F6F8;  /* Фон сторінки / shell */
  --color-neutral-75:     #F9FAFB;  /* Фон елементів мега-меню */
  --color-neutral-100:    #F3F4F6;  /* Hover рядки таблиць */
  --color-neutral-200:    #E5E7EB;  /* Розділювачі, рамки */
  --color-neutral-300:    #D1D5DB;  /* Рамки кнопок, полів вводу */
  --color-neutral-400:    #9CA3AF;  /* Плейсхолдери, підказки */
  --color-neutral-500:    #6B7280;  /* Підписи, мітки */
  --color-neutral-700:    #374151;  /* Другорядний текст */
  --color-neutral-900:    #111827;  /* Основний текст, заголовки */
}
```

### Теми оформлення (5 варіантів топбару)

Колір топбару (`--color-brand`) можна змінити через налаштування організації.  
Решта UI (картки, таблиці, форми) не змінюється — вони завжди нейтральні.

| Назва | `--color-brand` | `--color-brand-accent` | Застосування |
|-------|----------------|------------------------|-------------|
| **Navy** _(за замовч.)_ | `#1E3A5F` | `#3B82F6` | Класичний діловий |
| **Green** | `#166534` | `#22C55E` | Екологічна/сільгосп тематика |
| **Plum** | `#4C1D95` | `#8B5CF6` | Преміум-сервіс |
| **Teal** | `#0F6E56` | `#14B8A6` | Медицина, чистота |
| **Slate** | `#374151` | `#6B7280` | Мінімалістичний |

```typescript
// apps/web/src/shared/config/themes.ts
export const BRAND_THEMES = {
  navy:  { brand: '#1E3A5F', accent: '#3B82F6' },
  green: { brand: '#166534', accent: '#22C55E' },
  plum:  { brand: '#4C1D95', accent: '#8B5CF6' },
  teal:  { brand: '#0F6E56', accent: '#14B8A6' },
  slate: { brand: '#374151', accent: '#6B7280' },
} as const;

export type BrandTheme = keyof typeof BRAND_THEMES;
```

### Кольори статусів нарядів

| Статус | Колір | Hex | Клас Tailwind |
|--------|-------|-----|---------------|
| DRAFT | Сірий | `#6B7280` | `bg-neutral-100 text-neutral-700` |
| ESTIMATE | Блакитний | `#0EA5E9` | `bg-sky-100 text-sky-700` |
| APPROVED | Індиго | `#6366F1` | `bg-indigo-100 text-indigo-700` |
| IN_PROGRESS | Синій | `#3B82F6` | `bg-blue-100 text-blue-700` |
| ON_HOLD | Жовтий | `#F59E0B` | `bg-amber-100 text-amber-700` |
| COMPLETED | Зелений | `#22C55E` | `bg-green-100 text-green-700` |
| INVOICED | Фіолетовий | `#A855F7` | `bg-purple-100 text-purple-700` |
| PAID | Смарагдовий | `#10B981` | `bg-emerald-100 text-emerald-700` |
| ARCHIVED | Темно-сірий | `#374151` | `bg-gray-200 text-gray-600` |
| CANCELLED | Червоний | `#EF4444` | `bg-red-100 text-red-700` |

---

## 2. Типографіка

### Web (Next.js)

```css
/* Font: Inter (системний стек — не завантажуємо зовні для офлайн) */
font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;

/* Розміри */
--text-xs:   0.75rem;   /* 12px — мітки, підписи */
--text-sm:   0.875rem;  /* 14px — тіло таблиць, форм */
--text-base: 1rem;      /* 16px — основний текст */
--text-lg:   1.125rem;  /* 18px — підзаголовки */
--text-xl:   1.25rem;   /* 20px — заголовки карток */
--text-2xl:  1.5rem;    /* 24px — заголовки сторінок */
--text-3xl:  1.875rem;  /* 30px — головні заголовки */

/* Вага */
font-weight: 400;  /* regular — текст */
font-weight: 500;  /* medium — labels */
font-weight: 600;  /* semibold — заголовки */
font-weight: 700;  /* bold — важливе */
```

### Mobile (Expo)

```typescript
// apps/mobile/src/shared/ui/tokens/typography.ts
export const typography = {
  fontFamily: {
    regular: 'System',   // SF Pro (iOS) / Roboto (Android)
    medium:  'System',
    bold:    'System',
  },
  fontSize: {
    xs:   12,
    sm:   14,
    base: 16,
    lg:   18,
    xl:   20,
    '2xl': 24,
  },
  lineHeight: {
    tight:  1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
};
```

---

## 3. Відступи (Spacing)

```
4px  — xs  — внутрішні відступи дрібних елементів
8px  — sm  — відступи між елементами
12px — md  — відступи всередині компонентів
16px — lg  — відступи між секціями (стандарт)
24px — xl  — великі відступи
32px — 2xl — відступи між блоками
48px — 3xl — відступи між сторінковими секціями
```

### Заокруглення кутів

```
4px  — мітки статусів, теги
6px  — поля вводу, кнопки small
8px  — картки, кнопки
12px — модальні вікна
16px — великі картки
full — аватари, індикатори
```

---

## 4. Компоненти (shadcn/ui)

### Кнопки

```tsx
// Основна дія
<Button variant="default">Зберегти наряд</Button>

// Небезпечна дія
<Button variant="destructive">Скасувати наряд</Button>

// Другорядна
<Button variant="outline">Скасувати</Button>

// Привид
<Button variant="ghost">Редагувати</Button>

// FSM перехід — завжди з підтвердженням
<Button variant="default" onClick={() => setConfirmOpen(true)}>
  Перевести в роботу
</Button>
```

### Статусна мітка (Badge)

```tsx
// packages/ui/src/StatusBadge.tsx
const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT:       'Чернетка',
  ESTIMATE:    'Кошторис',
  APPROVED:    'Погоджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD:     'Призупинено',
  COMPLETED:   'Завершено',
  INVOICED:    'Виставлено рахунок',
  PAID:        'Оплачено',
  ARCHIVED:    'Архів',
  CANCELLED:   'Скасовано',
};
```

### Таблиці

- Використовувати `@tanstack/react-table`
- Заголовки: напівжирний, нейтральний фон
- Рядки: чергування фону (`bg-white` / `bg-neutral-50`)
- Hover: `hover:bg-primary-light`
- Мінімальна висота рядка: 48px (для тачскрінів)
- Пагінація: відображати "Показано 1-20 з 142"

### Форми

```tsx
// Стандартна форма з react-hook-form + Zod + shadcn/ui
<Form {...form}>
  <FormField
    control={form.control}
    name="vehicleId"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Автомобіль *</FormLabel>
        <FormControl>
          <VehicleCombobox {...field} />
        </FormControl>
        <FormMessage />  {/* Показує Zod помилку українською */}
      </FormItem>
    )}
  />
</Form>
```

---

## 5. Формати відображення (ОБОВ'ЯЗКОВО)

### Валюта

```typescript
// ✅ Правильно
formatCurrency(1250)    // → "1 250,00 ₴"
formatCurrency(0)       // → "0,00 ₴"
formatCurrency(1250.5)  // → "1 250,50 ₴"

// ❌ Неправильно
"1250 грн"
"UAH 1250"
"₴1250"
```

### Дати

```typescript
// ✅ Правильно
formatDate(date)          // → "21.05.2026"
formatDateTime(date)      // → "21.05.2026 14:30"
formatDateRelative(date)  // → "сьогодні", "вчора", "3 дні тому"

// ❌ Неправильно
"2026-05-21"
"May 21, 2026"
"21/05/2026"
```

### Телефони

```typescript
// ✅ Правильно
formatPhone("+380671234567")  // → "+380 67 123 45 67"
```

### Числа та одиниці

```typescript
// Кількість
formatQuantity(1.5, "шт")    // → "1,5 шт"
formatQuantity(2, "л")       // → "2 л"

// Норм-години
formatNormoHours(1.5)        // → "1,5 н/г"

// Пробіг
formatMileage(150000)        // → "150 000 км"
```

---

## 6. Стани завантаження

### Скелетон (замість спінера для списків)

```tsx
// Використовувати <Skeleton /> з shadcn/ui
<div className="space-y-2">
  <Skeleton className="h-12 w-full" />
  <Skeleton className="h-12 w-full" />
  <Skeleton className="h-12 w-3/4" />
</div>
```

### Порожній стан

```tsx
<EmptyState
  icon={<FileX />}
  title="Нарядів не знайдено"
  description="Створіть перший наряд для початку роботи"
  action={<Button>Створити наряд</Button>}
/>
```

### Помилка завантаження

```tsx
<ErrorState
  message="Не вдалося завантажити наряди"
  onRetry={() => refetch()}
/>
```

---

## 7. Мобільний інтерфейс (Expo)

### Специфіка для планшетів механіків

- Мінімальний розмір кнопок: **48×48px** (пальці в рукавицях)
- Шрифт основного тексту: мінімум **16px**
- Форми: великі поля вводу, достатній контраст
- Числові поля: відображати цифрову клавіатуру (`keyboardType="numeric"`)
- Фото: можливість знімати одразу через `expo-camera`

### Кольори для мобільного

```typescript
// apps/mobile/src/shared/ui/tokens/colors.ts
export const colors = {
  brand:      '#1E3A5F',  // топбар і головні кнопки
  accent:     '#3B82F6',  // активні іконки, зірочки
  primary:    '#1E3A5F',  // alias → brand
  background: '#F5F6F8',
  surface:    '#FFFFFF',
  border:     '#E5E7EB',
  text: {
    primary:   '#111827',
    secondary: '#374151',
    muted:     '#6B7280',
    disabled:  '#9CA3AF',
  },
  status: {
    success: '#16A34A',
    warning: '#D97706',
    danger:  '#DC2626',
    info:    '#1E40AF',
  },
};
```

---

## 8. Локалізація UI рядків

Всі рядки — **тільки українською**. Немає i18n — одна мова.

```typescript
// packages/shared/src/constants/ui-labels.ts

export const WorkOrderStatusLabels: Record<WorkOrderStatus, string> = {
  DRAFT:       'Чернетка',
  ESTIMATE:    'Кошторис',
  APPROVED:    'Погоджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD:     'Призупинено',
  COMPLETED:   'Завершено',
  INVOICED:    'Виставлено рахунок',
  PAID:        'Оплачено',
  ARCHIVED:    'Архів',
  CANCELLED:   'Скасовано',
};

export const UserRoleLabels: Record<UserRole, string> = {
  OWNER:        'Власник',
  ADMIN:        'Адміністратор',
  RECEPTIONIST: 'Приймальник',
  MECHANIC:     'Механік',
  STOREKEEPER:  'Комірник',
  ACCOUNTANT:   'Бухгалтер',
  CLIENT:       'Клієнт',
};

export const PaymentMethodLabels: Record<PaymentMethod, string> = {
  CASH:           'Готівка',
  CARD_TERMINAL:  'Картка (термінал)',
  BANK_TRANSFER:  'Банківський переказ',
  PRIVAT24_QR:    'PrivatPay QR',
  MONOBANK_QR:    'Monobank QR',
  CRYPTO:         'Криптовалюта',
};

// Повідомлення підтвердження
export const ConfirmMessages = {
  deleteRecord:    'Ви впевнені, що хочете видалити цей запис?',
  cancelWorkOrder: 'Ви впевнені, що хочете скасувати наряд? Цю дію неможливо відмінити.',
  archiveWorkOrder:'Перемістити наряд в архів?',
};

// Повідомлення про успіх (toast)
export const SuccessMessages = {
  workOrderCreated:    'Наряд успішно створено',
  workOrderTransition: (status: string) => `Статус змінено на "${status}"`,
  paymentReceived:     'Оплату зафіксовано',
  stockReceived:       'Товар прийнято на склад',
};
```

---

## 9. Навігаційна оболонка (Shell)

### Структура та розміри

```
┌─────────────────────────────────────────────────────┐  48px  Topbar
│ [Лого]  [Довідники ▼] [Документи ▼] [Звіти ▼] ...  │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐  260px max  Мега-меню
│  [іконка] Назва ★   [іконка] Назва ★   ...          │  (анімовано, max-height)
│  [іконка] Назва ★   [іконка] Назва ★   ...          │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐  34px  Рядок закладок
│ [📋 Наряди ×]  [👥 Контрагенти ×]  [+ Додати]       │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│  [Дашборд | Робоча область]                         │  Перемикач виду
│                                                     │
│  Контент сторінки                                   │  Фон: --color-neutral-50
└─────────────────────────────────────────────────────┘
```

### CSS-токени оболонки

```css
/* Topbar */
--shell-topbar-height:      48px;
--shell-topbar-bg:          var(--color-brand);        /* #1E3A5F */
--shell-topbar-text:        rgba(255,255,255,0.72);
--shell-topbar-text-active: #ffffff;
--shell-topbar-indicator:   rgba(255,255,255,0.55);    /* підкреслення активного пункту */
--shell-topbar-separator:   rgba(255,255,255,0.18);

/* Мега-меню */
--shell-mega-bg:            #ffffff;
--shell-mega-border:        #E5E7EB;
--shell-mega-max-height:    260px;
--shell-mega-item-bg:       #F9FAFB;
--shell-mega-item-hover-bg: #EFF6FF;
--shell-mega-item-hover-border: #DBEAFE;
--shell-mega-icon-color:    var(--color-brand-accent); /* #3B82F6 */
--shell-mega-label-color:   #374151;
--shell-mega-pin-default:   #D1D5DB;
--shell-mega-pin-active:    var(--color-brand-accent);

/* Рядок закладок */
--shell-qtab-height:        34px;
--shell-qtab-bg:            #ffffff;
--shell-qtab-border:        #E5E7EB;
--shell-qtab-text:          #6B7280;
--shell-qtab-active-bg:     #EFF6FF;
--shell-qtab-active-text:   var(--color-brand);
--shell-qtab-active-border: #DBEAFE;

/* Фон контенту */
--shell-content-bg:         #F5F6F8;
```

### Поведінка навігації

```
Мега-меню:
  - Відкривається кліком по пункту верхнього меню (не hover)
  - Закривається кліком поза меню або повторним кліком по тому ж пункту
  - Анімація: max-height 0 → 260px, transition 220ms cubic-bezier(.4,0,.2,1)
  - Стрілка ▼ обертається на 180° при відкритті

Закладки (Quick tabs):
  - Користувач натискає ★ поряд з будь-яким елементом мега-меню
  - Закладка з'являється у рядку швидкого доступу
  - Кнопка [×] на закладці — прибрати з рядка
  - Кнопка [+ Додати] — відкриває мега-меню для вибору
  - Порядок закладок зберігається в localStorage (ключ: sto-erp-pinned-tabs)
  - Максимум 12 закладок
  - Набір закладок — per-user (зберігається з профілем у БД, sync через API)

Перемикач виду:
  - [Дашборд] — KPI-панель, графіки, сповіщення
  - [Робоча область] — таблиця поточних документів розділу
  - Стан зберігається в URL: ?view=dash | ?view=work
```

### Компонент TopShell (React)

```tsx
// apps/web/src/widgets/shell/TopShell.tsx
interface TopShellProps {
  theme?: BrandTheme;           // 'navy' | 'green' | 'plum' | 'teal' | 'slate'
  currentUser: { initials: string; name: string };
  currentBranch: { id: string; name: string };
}

// Дочірні компоненти:
// <TopBar />           — верхній рядок з навігацією
// <MegaMenu />         — мега-меню (керується станом відкритого пункту)
// <QuickTabsBar />     — рядок закріплених закладок
// <ViewToggle />       — перемикач Дашборд / Робоча область
```

---

## 10. Бейджі статусів

Єдиний стандарт для всіх статусів у таблицях і картках.

```typescript
// packages/ui/src/StatusBadge.tsx
type BadgeVariant = 'draft' | 'estimate' | 'progress' | 'hold' |
                   'done' | 'invoiced' | 'paid' | 'cancelled' | 'info';

const BADGE_STYLES: Record<BadgeVariant, { bg: string; text: string; border: string }> = {
  draft:     { bg: '#F9FAFB', text: '#374151', border: '#E5E7EB' },
  estimate:  { bg: '#EFF6FF', text: '#1E40AF', border: '#DBEAFE' },
  progress:  { bg: '#FFFBEB', text: '#92400E', border: '#FDE68A' },
  hold:      { bg: '#FEF3C7', text: '#78350F', border: '#FCD34D' },
  done:      { bg: '#F0FDF4', text: '#166534', border: '#BBF7D0' },
  invoiced:  { bg: '#F5F3FF', text: '#4C1D95', border: '#DDD6FE' },
  paid:      { bg: '#ECFDF5', text: '#064E3B', border: '#A7F3D0' },
  cancelled: { bg: '#FFF1F2', text: '#9F1239', border: '#FECDD3' },
  info:      { bg: '#EFF6FF', text: '#1E40AF', border: '#DBEAFE' },
};

// CSS-клас для Tailwind:
// bg-neutral-50 text-neutral-700 border border-neutral-200  → draft
// bg-blue-50 text-blue-800 border border-blue-200           → estimate / info
// bg-amber-50 text-amber-800 border border-amber-300        → progress / hold
// bg-green-50 text-green-800 border border-green-200        → done
// bg-purple-50 text-purple-900 border border-purple-200     → invoiced
// bg-emerald-50 text-emerald-900 border border-emerald-200  → paid
// bg-rose-50 text-rose-900 border border-rose-200           → cancelled
```

### Мапа статусів WorkOrder → варіант бейджу

```typescript
export const WO_STATUS_BADGE: Record<WorkOrderStatus, BadgeVariant> = {
  DRAFT:       'draft',
  ESTIMATE:    'estimate',
  APPROVED:    'info',
  IN_PROGRESS: 'progress',
  ON_HOLD:     'hold',
  COMPLETED:   'done',
  INVOICED:    'invoiced',
  PAID:        'paid',
  ARCHIVED:    'draft',
  CANCELLED:   'cancelled',
};
```

---

## 11. Сповіщення (Alert / Toast)

### Inline-сповіщення (в дашборді)

```tsx
// Завжди з border-left акцентом, без заокруглення зліва
// border-left: 2.5px solid <color>; border-radius: 0 6px 6px 0

type AlertSeverity = 'error' | 'warning' | 'info' | 'success';

const ALERT_ACCENT: Record<AlertSeverity, string> = {
  error:   '#EF4444',   // Низький залишок, критична помилка
  warning: '#F59E0B',   // Прострочений рахунок, попередження
  info:    '#3B82F6',   // Інформаційне повідомлення
  success: '#22C55E',   // Успішна операція
};
```

### Toast-сповіщення (react-hot-toast / sonner)

```typescript
// Позиція: bottom-right
// Тривалість: 4000ms (success/info), 6000ms (warning/error)
// Максимум на екрані: 3

import { toast } from 'sonner';

toast.success('Наряд успішно створено');
toast.error('Помилка збереження. Перевірте з\'єднання.');
toast.warning('Залишок масла нижче мінімуму');
toast.info(`Статус змінено на "${status}"`);
```

---

## 12. Структура сторінки (Page Layout)

```tsx
// apps/web/src/widgets/shell/PageLayout.tsx
// Стандартна обгортка для кожної сторінки

<PageLayout
  title="Наряди"                  // h1 сторінки
  breadcrumb={['Документи', 'Наряди']}
  actions={<Button>Новий наряд</Button>}   // права частина заголовку
>
  <ViewToggle />       {/* Дашборд / Робоча область */}
  <DashboardView />    {/* або <WorkspaceView /> */}
</PageLayout>

// Розміри:
// Ширина контенту: max-width 1440px, padding 0 16px
// Заголовок сторінки: h1 20px/500, margin-bottom 16px
// Хлібні крихти: 12px, color neutral-500, separator "/"
```

