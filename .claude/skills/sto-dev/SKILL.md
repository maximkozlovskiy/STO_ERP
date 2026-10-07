---
name: sto-dev
description: >
  STO ERP coding standards — applied DURING code writing, not after. Covers TypeScript quality rules, NestJS patterns, Next.js 15 patterns, Tailwind 4 canonical syntax, Prisma 5 patterns, and domain-specific invariants. Use as a reference while implementing sto-backend, sto-web, sto-database tasks. Prevents the bugs that sto-review and sto-tester catch.
model: claude-haiku-4-5-20251001
bypassPermissions: true
---

# sto-dev — Coding Standards

> Застосовується **під час написання**, не після. Мета: `/sto-review` знаходить 0 проблем. Живий документ — після кожного `/sto-review`/`/sto-tester` додавай новий патерн, якщо баг тут не покритий.

## Зміст

| §                      | Секція                                                                                                                                         | Де лежить                        | Для кого                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------- |
| §1                     | TypeScript                                                                                                                                     | цей файл                         | Всі `.ts`/`.tsx`                              |
| §2                     | NestJS / API                                                                                                                                   | `sections/api.md`                | `*.controller.ts`, `*.service.ts`, `*.dto.ts` |
| §3                     | Next.js 15 / Web                                                                                                                               | `sections/web.md`                | `apps/web/src/**`                             |
| §4                     | UX/UI Features System                                                                                                                          | `sections/web.md`                | Хуки та компоненти UI                         |
| §5                     | Tailwind 4 — Canonical Syntax                                                                                                                  | `sections/web.md`                | Будь-який `.tsx` з className                  |
| §6                     | Prisma 5                                                                                                                                       | `sections/api.md`                | `schema.prisma`, `*.service.ts` з Prisma      |
| §7                     | SSE — Real-time                                                                                                                                | `sections/api.md`                | Streaming endpoints, EventSource              |
| §8                     | Optimistic UI                                                                                                                                  | `sections/web.md`                | FSM кнопки, форми з негайним відгуком         |
| §9                     | Polymorphic entities                                                                                                                           | `sections/api.md`                | Comments, AuditLog, Media                     |
| §10                    | Webhook pattern                                                                                                                                | `sections/api.md`                | Outbound webhooks                             |
| §11                    | Offline-first / BullMQ                                                                                                                         | `sections/api.md`                | Зовнішні API, SMS, ПРРО                       |
| §12                    | Безпека                                                                                                                                        | цей файл                         | Auth guards, tenant isolation                 |
| §13                    | Checklist перед здачею                                                                                                                         | цей файл                         | Всі зміни перед комітом                       |
| §14, §15, §18, §25     | Модульність (§14), Schema-driven UI (§15), Modal+Tabs (§18), DRY хуки і shared constants (§25, §25.5)                                          | `sections/web-ui-standards-1.md` | UI-архітектура                                |
| §16, §17, §19–§24, §26 | shared constants (§16), API-хуки (§17/§20/§22), FSMButtons (§19), Zod (§21), TableContainer (§23), EntityPickerField (§24), Settings Tab (§26) | `sections/web-ui-standards-2.md` | UI-архітектура                                |

Секції з колонки «Де лежить» читати цілком (кожна влазить в один Read) — лише ті, яких стосується
задача. Заголовки-вказівники «## Назва → `sections/x.md`» нижче лишені, щоб пошук за назвою
розділу в цьому файлі приводив до потрібного файла.

> **Швидкий старт:** новий контролер → §1+§2+§12 (цей файл + `sections/api.md`). Нова сторінка → §1+§3+§5 (цей файл + `sections/web.md`; list-сторінка, модалка, таблиця — ще й `web-ui-standards-*.md`). Prisma модель → §1+§6 (цей файл + `sections/api.md`).

---

## TypeScript

### tsconfig.json — валідні значення

```json
// ❌ "ignoreDeprecations": "6.0" — TS 5.9 дає TS5103 "Invalid value"
// ❌ "baseUrl": "."             — deprecated, видалити (paths працює без нього у TS 5+)
// ❌ "rootDir": "src" + paths поза src — конфлікт "common source directory"

// ✅ TS 5.x
{
  "ignoreDeprecations": "5.0", // тільки "5.0" валідне до TS 6.0
  "moduleResolution": "node", // для NestJS (commonjs)
  "module": "commonjs", // NestJS не сумісний з node16 module
  // НЕМАЄ baseUrl — paths відносні до tsconfig.json
  "paths": { "@sto/shared": ["../../packages/shared/src"] }
}
```

> `ignoreDeprecations` ≤ поточної TS major. На TS 5.9 валідне тільки `"5.0"`.

### Заборонені патерни

```typescript
// ❌ any
const user: any = ...;
function process(data: any) {}

// ❌ React namespace без імпорту
function Card({ children }: { children: React.ReactNode })  // → import type { ReactNode }

// ❌ non-null assertion без причини
const id = user!.id;  // якщо user може бути undefined — додай guard

// ❌ as-cast замість перевірки
const result = data as WorkOrder;  // → перевір тип або використай type guard

// ❌ Enum як magic string
status: 'IN_PROGRESS'  // → status: WorkOrderStatus.IN_PROGRESS (або з Prisma enum)
```

### Обов'язкові патерни

```typescript
// ✅ Explicit React type imports
import type { ReactNode, HTMLAttributes, SVGAttributes } from 'react';
import { useState, useEffect, type FC } from 'react';

// ✅ Discriminated union замість флагів
type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WorkOrder[] }
  | { status: 'error'; message: string };

// ✅ Exhaustive switch
function getLabel(status: WorkOrderStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Чернетка';
    case 'ESTIMATE':
      return 'Кошторис';
    // ... всі варіанти
    default: {
      const _: never = status; // compile-time exhaustiveness check
      return status;
    }
  }
}

// ✅ Zod для runtime validation на boundary
const dto = CreateWorkOrderSchema.parse(body); // не cast, а parse
```

---

## NestJS / API → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Next.js 15 / Web → `sections/web.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## UX/UI Features System (Phase 20) → `sections/web.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Tailwind 4 — Canonical Syntax → `sections/web.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Спек-файли: один аспект = один файл

Тести не дописуються `it()`-ом у найбільший спек модуля. Структура:

```
<module>.<аспект>.spec.ts     # pricing, fsm, totals, sort, linked-docs…
<module>.spec-fixture.ts      # спільний DI/harness, ТІЛЬКИ коли потрібен 3+ файлам
```

**Фікстура = factory, не `const`.** `vitest.config.ts` має `isolate: false` без
`clearMocks`, тож module-level `vi.fn()` тече між файлами одного воркера:

```ts
// ❌ спільний стан між спеками
export const statusesMock = { provide: X, useValue: { f: vi.fn() } };

// ✅ новий набір на кожен виклик
export const statusesProvider = () => ({ provide: X, useValue: { f: vi.fn() } });
```

У `*.spec-fixture.ts` eslint суворіший, ніж у `*.spec.ts`: `async` без `await` —
**error**. Писати `Promise.resolve(...)`, не `async () => (...)`.

Який файл правити — каже реєстр у `docs/objects/<entity>.md`
(«Аспекти і тести, що їх стережуть»). Нове правило → новий `BR-XXX-NNN` там же.
Гейти: `python scripts/check-spec-registry.py --gate-size|--gate-registry`.

## Prisma 5 → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## SSE (Server-Sent Events) — Real-time дані без WebSocket → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Optimistic UI — миттєвий відгук без очікування API → `sections/web.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Polymorphic entities — Comments, AuditLog, Media → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Webhook pattern — вихідні нотифікації → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Offline-first / BullMQ → `sections/api.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Безпека

Cross-tenant scoping (`orgId` у кожному запиті) — див. §2 Service правило 1 (`sections/api.md`).

```typescript
// ❌ Сирий SQL з інтерполяцією
await this.prisma.$queryRaw(`SELECT * FROM users WHERE name = '${name}'`);

// ✅ Параметризований
await this.prisma.$queryRaw`SELECT * FROM users WHERE name = ${name}`;

// ❌ Raw SQL зі snake_case — Postgres folds unquoted identifiers до lowercase
// і НЕ знайде колонок Prisma (які створені double-quoted camelCase, бо schema без @map)
await this.prisma.$queryRaw`
  SELECT * FROM stock_items
  WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
`; // ← throws: column "org_id" does not exist

// ✅ Raw SQL з camelCase у подвійних лапках
await this.prisma.$queryRaw`
  SELECT * FROM stock_items
  WHERE "orgId" = ${orgId}::uuid AND "deletedAt" IS NULL
  LIMIT 500
`;

// ❌ Чутливі поля в response DTO
return { id, phone, edrpou, rateScheme, passwordHash }; // ← ніколи!

// ✅ Тільки потрібні поля
return { id, firstName, lastName, phone };
```

---

## Коментарі — коли і як

### ЗАБОРОНЕНО (видаляти при code review)

```typescript
// ❌ Bug/Issue/PR reference — не належить коду, належить commit message
// Bug #123: виправлено N+1 запит
// Fix #456: додано перевірку null
// Cycle 2/3 step 3 — ...

// ❌ Що робить очевидний код
// Знаходимо замовлення
const wo = await prisma.workOrder.findFirst(...)
// Повертаємо результат
return result;
// Фільтруємо видалені
where: { deletedAt: null }
// Increment counter
counter++;

// ❌ TODO без конкретного WHY або дедлайну
// TODO: рефакторити
// TODO: покращити продуктивність
// FIXME: не знаю чому це потрібно
```

### ДОЗВОЛЕНО (корисні коментарі)

```typescript
// ✅ Прихований constraint або інваріант
// SettlementAccount — singleton per counterparty, ніколи не видаляється (немає deletedAt)
const account = await prisma.settlementAccount.findFirst({ where: { counterpartyId } });

// ✅ Workaround з причиною (платформний баг, обмеження версії)
// SWC не резолвить tsconfig paths на Windows — залишати tsc builder

// ✅ DST/timezone пастка
// Kyiv offset +02/+03 залежно від DST — завжди Intl.DateTimeFormat, ніколи hardcode

// ✅ Security reasoning де неочевидно
// getOrThrow (не get) — fallback до відомого рядка дозволяє auth bypass в prod

// ✅ Postgres-специфічна поведінка
// ADD VALUE — окремий файл міграції: Postgres забороняє ADD VALUE + використання в одній транзакції
// camelCase у подвійних лапках: Postgres без quotes folds до lowercase (orgId → orgid)

// ✅ Performance invariant де неочевидно
// Module-level singleton: new Intl.DateTimeFormat() дорогий (locale init) — не в циклі

// ✅ Race condition guard
// Refs ensure handleModalClose sees sync state, not stale closure

// ✅ Явний timeout (пояснити чому нестандартний)
// explicit timeout 10s — COMPLETED транзакція робить N writeoff + N release + 1 charge
// при 50+ запчастинах це може зайняти > 5s default
await prisma.$transaction(async tx => { ... }, { timeout: 10_000 });

// ✅ TODO з конкретним WHY і умовою коли виправити
// Multi-branch gap: single-branch assumption — для multi-branch orgs потрібен resolve
// per-vehicle by lastWorkOrderBranchId або Organisation-level SMS config

// ✅ regression guard В ТЕСТАХ (тільки в *.spec.ts / *.test.ts)
// regression guard: якщо видалиш цей тест, Bug #NNN відтвориться мовчки
```

---

## Checklist перед здачею коду

```
TypeScript
  [ ] Немає `any` типів
  [ ] Немає `React.X` namespace без імпорту
  [ ] Немає `console.log`
  [ ] Enums з Prisma/shared, не magic strings
  [ ] Немає `// Bug #NNN:` коментарів (належать commit message, не коду)
  [ ] Немає коментарів що пояснюють ЩО (// Знаходимо, // Повертаємо, // Filter deleted)
  [ ] TODO залишені тільки якщо є конкретний WHY (обмеження, constraint, дедлайн)

NestJS
  [ ] Кожен запит фільтрується по `orgId`
  [ ] `deletedAt: null` у кожному findMany/findFirst
  [ ] FSM через transition map
  [ ] Зміни складу через InventoryService
  [ ] Зміни балансу через SettlementsService
  [ ] Кілька таблиць → $transaction
  [ ] Помилки українською
  [ ] toResponseDto() — без raw Prisma моделей

Next.js
  [ ] Date/time тільки в useEffect, не в render
  [ ] Per-row savingId, не глобальний saving
  [ ] Окремий formError від pageError
  [ ] loading: true при ініціалізації
  [ ] Cleanup у useEffect (removeEventListener, clearInterval)
  [ ] apiFetch, не fetch/axios напряму

UX/UI Features
  [ ] toast.X завжди за `if (features.toastEnabled)`
  [ ] Fallback на setError коли toast вимкнено
  [ ] useDirtyForm: resetDirty() після успішного збереження
  [ ] useInlineEdit: commitEdit завжди .catch(() => {})
  [ ] useBulkSelect: Promise.allSettled, не Promise.all
  [ ] bulkSelect.clear() + load() в finally-логіці bulk-операцій
  [ ] indeterminate checkbox через useRef+useEffect, не inline ref callback
  [ ] colSpan у loading/empty rows враховує bulkActionsEnabled
  [ ] useSavedFilters: Array.isArray guard при читанні localStorage
  [ ] NotificationCenter delete button: group/group-hover + focus:opacity-100
  [ ] onKeyDown на role="button" обгортках: guard e.target !== e.currentTarget
  [ ] Collapsible секція поза Modal: AnimatedBody з @/components/ui/modal, не maxHeight magic number

Tailwind
  [ ] `[var(--x)]` → `(--x)` або canonical token
  [ ] Pixel значення → Tailwind scale (px/4)
  [ ] `flex-shrink-0` → `shrink-0`

Prisma
  [ ] Усі нові моделі мають 6 обов'язкових полів
  [ ] findMany з take (pagination)
  [ ] Немає .delete() на бізнес-сутностях

Безпека
  [ ] orgId у кожному запиті
  [ ] Немає чутливих полів у response DTO
  [ ] Параметризований SQL (template literals)
  [ ] BullMQ для зовнішніх API
```

---

## §14 Модульність і Універсальність UI → `sections/web-ui-standards-1.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §25 — DRY: хуки і компоненти як єдине місце правди → `sections/web-ui-standards-1.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §18 — Modal + ModalTabs для 1-N зв'язків → `sections/web-ui-standards-1.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §15 Schema-driven UI (metadata-driven rendering) → `sections/web-ui-standards-1.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §16 SharedStatusConstants — єдине місце для статусів → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §17 usePaginatedList — generic API hook factory → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §19 FSMButtons — shared компонент FSM-переходів → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §20 useApiMutation — wrapper для мутацій → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §21 Shared Zod validators → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §22 useApiError — централізований handler помилок → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §23 TableContainer — контейнер таблиці зі sticky-шапкою → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §24 — EntityPickerField + \*EditModal: стандарт поля-посилання → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## §26 Settings Tab — стандарт вкладки налаштувань → `sections/web-ui-standards-2.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Інтеграція у флоу

```
/sto-context
    ↓
/sto-database  ← schema: обов'язкові поля, soft delete, індекси
    ↓
/sto-backend   ← [читай цей скіл] сервіси, контролери, DTOs
    ↓
/sto-web       ← [читай цей скіл] компоненти, хуки, Tailwind
    ↓
/sto-review    ← перевіряє що цей скіл дотриманий
    ↓
/sto-tester    ← знаходить runtime баги
```

> `/sto-dev` — живий документ. Після кожного `/sto-review`/`/sto-tester`, якщо знайдено баг якого тут немає, **одразу додай** новий патерн.
