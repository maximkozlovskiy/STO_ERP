# BUG_REPORT.md — STO ERP

Дата: 2026-05-24
Сесія: /sto-tester цикл після додавання Playwright секції в SKILL.md

---

## Bug #1 — [MEDIUM] Дубль сервісу нумерації документів

**Файл:** `apps/api/src/modules/settings/document-numbering.service.ts`
**Severity:** MEDIUM
**Категорія:** business-logic / dead-code

**Опис:**
У проєкті існує **два** окремих сервіси нумерації документів:
- `apps/api/src/modules/document-number/document-number.service.ts` — `DocumentNumberService` (вживається у `work-orders`, `invoices`, `purchase-orders`, `stock-documents`)
- `apps/api/src/modules/settings/document-numbering.service.ts` — `DocumentNumberingService` (зареєстрований в `settings.module.ts`, але нікуди не імпортується)

Обидва читають одну й ту саму таблицю `document_number_configs`, але алгоритми reset/формат відрізняються (різні стратегії reset, різний date_format). Якщо колись `DocumentNumberingService` випадково підключать — отримаємо неконсистентну нумерацію між модулями. Це потенційна корупція даних (дублікати номерів між WO і Invoice неможливі через окремі `document_type`, але неоднакові правила reset порушать audit trail).

**Очікувана поведінка:**
Один сервіс нумерації — `DocumentNumberService` у `modules/document-number`. Видалити `DocumentNumberingService` з `settings` модуля разом з реєстрацією в `settings.module.ts`.

**Фактична поведінка:**
Дві паралельні реалізації, тільки одна активно вживається.

**Статус:** [x] виправлено

---

## Bug #2 — [LOW] services.service.ts FK-валідація findMany без take safety guard

**Файл:** `apps/api/src/modules/services/services.service.ts:53,60,94,106`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`tx.work.findMany({ where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null } })` і аналогічно для `tx.good.findMany`. DTO задає теоретичний ліміт, але per skill policy потрібен `take: 1000` як safety guard від корумпованих DTO.

**Очікувана поведінка:**
`take: 1000` додано до всіх 4 викликів.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] employees.service.ts FK-валідація findMany без take safety guard

**Файл:** `apps/api/src/modules/employees/employees.service.ts:86,106,129`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`this.prisma.zone.findMany({ where: { id: { in: dto.zoneIds }, orgId, deletedAt: null } })` (і аналогічно для lift, workCategory) — без `take: 1000` safety guard.

**Очікувана поведінка:**
`take: 1000` додано до всіх 3 викликів.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #5 — [LOW] services.service.ts serviceWorks/serviceGoods relation includes без take

**Файл:** `apps/api/src/modules/services/services.service.ts:19,20,33,34,70,71,120,121`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
8 relation includes для `serviceWorks` і `serviceGoods` без `take: 1000` safety guard. Хоча сервіс зазвичай має небагато робіт/товарів, policy вимагає додавати ліміт.

**Очікувана поведінка:**
Додати `take: 1000` до всіх 8 relation includes.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #4 — [LOW] purchase-orders.service.ts findOne lines relation include без take

**Файл:** `apps/api/src/modules/purchase-orders/purchase-orders.service.ts:59`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`lines: { where: { deletedAt: null }, include: { good: ... } }` — пропущений `take` на relation include. Минулий цикл `/sto-tester` (Bug #4 у попередній сесії) додав `take: 1000` до інших викликів, але цей пропустив.

**Очікувана поведінка:**
Додати `take: 1000` до relation include.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---
