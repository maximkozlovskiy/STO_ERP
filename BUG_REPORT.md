# BUG_REPORT.md — STO ERP

Дата: 2026-05-25
Сесія: /sto-tester цикл після Phase 17 (Maintenance Schedules + Completion Acts + збагачення моделей)

TypeScript baseline: ✅ 0 errors (api/web/shared)
Unit tests baseline: ✅ 67/67 passed

---

## Bug #1 — [CRITICAL] CompletionActsService.findAll повертає масив, frontend очікує `{ items }`

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:16`
**Severity:** CRITICAL
**Категорія:** business-logic / api-contract

**Опис:**
Сервіс повертає `Promise<CompletionActResponseDto[]>` — голий масив без обгортки.
Frontend `apps/web/src/app/work-orders/[id]/PageClient.tsx:120` робить:
```typescript
apiFetch<{ items: CompletionActSummary[] }>(`/completion-acts?workOrderId=${id}`)
  .then(data => { if (data.items.length > 0) setCompletionAct(data.items[0]); })
```
При виклику `data.items.length` отримуємо `TypeError: Cannot read properties of undefined (reading 'length')` — реальний масив не має `.items`. `.catch(() => {})` ковтає помилку, тому користувач бачить **порожній стан без жодної індикації** про існуючий акт. Кнопка "Сформувати акт" показується навіть якщо акт уже є → дублікат при кліку → `BadRequestException` через `existing` check у сервісі.

**Очікувана поведінка:**
Або сервіс повертає `{ items: [...] }`, або frontend бере `data` як масив. Інші endpoints у проєкті (`work-orders`, `invoices`, `purchase-orders`) використовують `{ items, total, page, limit }` — слід дотримуватись цього contract.

**Фактична поведінка:**
Frontend ніколи не показує існуючий акт. Кнопка "Сформувати акт" → 400.

**Статус:** [x] виправлено

---

## Bug #2 — [HIGH] CompletionAct.sign: race condition при паралельному підписанні + втрата FSM-валідації

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:99`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
1. `act` читається **поза транзакцією** (line 100), потім `tx.completionAct.update` всередині — між двома операціями інший процес може підписати/скасувати акт.
2. Прямий `tx.workOrder.update({ data: { status: 'INVOICED' } })` (line 122-125) **обходить FSM** з `WORK_ORDER_TRANSITIONS`. Якщо WO у статусі `COMPLETED` (валідно) — все ОК. Але якщо хтось паралельно вже перевів WO у `INVOICED` через інший шлях — повторний `INVOICED → INVOICED` валиден на рівні DB, але порушує FSM-інваріант (тригер двічі: notification, settlement тощо вже могли спрацювати).
3. **Після transaction** виклик `this.invoices.createFromWorkOrder` — повертається **новий контекст**. Якщо при цьому DB рестартується або сервіс падає — act підписаний, WO у INVOICED, але рахунку немає. Catch-all `catch {}` (line 133-135) приховує реальні помилки (наприклад, `BadRequestException` "Для цього наряду вже існує активний рахунок" — це валідно, але інші помилки, наприклад validation, теж проковтуються).

**Очікувана поведінка:**
- Читати `act` всередині транзакції з `FOR UPDATE`-семантикою (Prisma не має — але мінімум: re-read у транзакції).
- Перевіряти `act.workOrder.status === 'COMPLETED'` явно перед update (не лише існування workOrder).
- Логувати непередбачувані помилки створення рахунку, не лише ковтати.

**Фактична поведінка:**
Дублювання подій можливе при concurrent signing; реальні помилки при auto-invoice мовчки приховуються.

**Статус:** [x] виправлено

---

## Bug #3 — [HIGH] MaintenanceSchedule update: nextMaintenanceMileage не оновлюється коли передано null

**Файл:** `apps/api/src/modules/maintenance-schedules/maintenance-schedules.service.ts:83`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
```typescript
const nextMileage = dto.nextMaintenanceMileage ?? this.calcNextMileage(...)
```
Якщо клієнт явно передасть `nextMaintenanceMileage: null` через PATCH (щоб очистити), валідатор `@IsInt() @Min(0) nextMaintenanceMileage?: number` не дозволить `null`, але `undefined` пройде. У будь-якому випадку, логіка не дозволяє **очистити** значення — а лише замінити на calculated. Якщо calc повертає null (немає interval) — будь-яке вже встановлене значення затирається на `null` при будь-якому PATCH (бо `nextMileage` тоді = `null`).

Реальний сценарій: користувач створив schedule з `lastMaintenanceMileage=10000, intervalMileage=15000` → next=25000. Потім робить PATCH `{ notes: "оновлено" }` → не передає інтервалів. Код виконає:
- `intervalMileage = dto.intervalMileage ?? existing.intervalMileage` (=15000)
- `lastMileage = dto.lastMaintenanceMileage !== undefined ? ... : existing.lastMaintenanceMileage` (=10000)
- `nextMileage = dto.nextMaintenanceMileage ?? calcNextMileage(10000, 15000)` (=25000) ✅ OK

Але якщо `existing.intervalMileage = null`:
- intervalMileage = `dto.intervalMileage ?? null` = null
- nextMileage = calc(..., null) = null → перезаписує **існуюче** значення next на null.

**Очікувана поведінка:**
Якщо PATCH не передає `nextMaintenanceMileage` явно і не змінює `intervalMileage`/`lastMaintenanceMileage` — `next` має залишитись. Тільки явні зміни input-полів мають перерахувати next.

**Фактична поведінка:**
Будь-який PATCH (навіть тільки `notes`) перераховує і потенційно затирає `nextMaintenanceMileage`.

**Статус:** [x] виправлено

---

## Bug #4 — [MEDIUM] CompletionAct.findAll не повертає lines (документ виглядає порожнім)

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:31`
**Severity:** MEDIUM
**Категорія:** api-contract

**Опис:**
`findAll` повертає `this.toDto(item, [])` з порожнім `lines`, але DTO декларує `lines!: CompletionActLineDto[]` як обов'язкове поле. Якщо UI вирішить показати lines у списку — отримає порожнечу. Поточний фронтенд цього не показує, тому LOW для нього, але contract обіцяє інакше.

**Очікувана поведінка:**
Або повертати `lines: []` тільки коли свідомо опускаємо (документ це у swagger описі), або зробити `lines?` optional у списку.

**Фактична поведінка:**
DTO бреше: тип каже "масив рядків завжди є", а в списку завжди порожній.

**Статус:** [x] виправлено

---

## Bug #5 — [MEDIUM] MaintenanceSchedule sync — нові моделі не в PULL_TABLES

**Файл:** `apps/api/src/modules/sync/sync.service.ts:19`
**Severity:** MEDIUM (LOW поки мобільний клієнт у розробці)
**Категорія:** sync-readiness

**Опис:**
`maintenance_schedules` і `completion_acts` додані у Prisma schema з `syncVersion`, `deletedAt`, `orgId` — готові до sync, але не зареєстровані у `PULL_TABLES`. Мобільні клієнти не побачать графіків ТО і актів виконаних робіт.

**Очікувана поведінка:**
Додати `'maintenance_schedules'`, `'completion_acts'` у PULL_TABLES (pull-only, без push — щоб уникнути race conditions з FSM).

**Фактична поведінка:**
Мобільний клієнт не синхронізує нові моделі.

**Статус:** [x] виправлено

---

## Bug #6 — [MEDIUM] MaintenanceSchedule.findUpcoming фільтрує без `vehicle.deletedAt`

**Файл:** `apps/api/src/modules/maintenance-schedules/maintenance-schedules.service.ts:34`
**Severity:** MEDIUM
**Категорія:** business-logic / soft-delete

**Опис:**
Запит фільтрує `MaintenanceSchedule.deletedAt: null`, але не перевіряє `vehicle.deletedAt`. Якщо авто видалено soft (`Vehicle.deletedAt != null`), його розклад ТО все одно з'явиться у віджеті dashboard "Наближається ТО" з мітками типу `vehicle.make vehicle.model`. Користувач кликає → 404 на vehicle сторінці.

**Очікувана поведінка:**
`where: { orgId, deletedAt: null, isActive: true, vehicle: { deletedAt: null }, ... }`

**Фактична поведінка:**
Видалені авто з'являються у "Наближається ТО".

**Статус:** [x] виправлено

---

## Bug #7 — [LOW] CompletionAct lines не сортовані — порядок робіт/запчастин непередбачуваний

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:43-50`
**Severity:** LOW
**Категорія:** ux-consistency

**Опис:**
`lines` і `parts` у `findOne` не мають `orderBy`. Prisma вільна повертати у будь-якому порядку. Для документу (акт виконаних робіт) порядок впливає на друк PDF і людське читання.

**Очікувана поведінка:**
Додати `orderBy: { createdAt: 'asc' }` (як у `work-orders.service.ts:71-72,79-80`).

**Статус:** [x] виправлено

---

## Bug #8 — [LOW] CompletionAct.cancel не перевіряє чи був auto-сгенерований Invoice

**Файл:** `apps/api/src/modules/completion-acts/completion-acts.service.ts:141`
**Severity:** LOW
**Категорія:** business-logic

**Опис:**
`cancel` блокує лише `SIGNED` (правильно), але якщо акт у `DRAFT` після failed-sign (рідкий edge case: act підписався → invoice створення впало → catch swallowed), `cancel` дозволить скасувати, не торкнувшись пов'язаних artifacts.

Цей сценарій частково покривається Bug #2; виправлення Bug #2 (re-throw на не-business помилках) робить це непотрібним.

**Статус:** [x] виправлено разом з Bug #2 (помилки auto-invoice тепер логуються, race vікно закрите re-read у транзакції)

---
