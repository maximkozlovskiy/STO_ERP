# sto-review — журнал: database

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/database.md`.

### 2026-05-28 — schema.prisma enum/поле змінено без міграції — §6

**Сигнал:** diff містить зміну `schema.prisma` (нове enum-значення/поле/модель) але без папки у `migrations/`.
**Фікс:** папка `YYYYMMDDHHMMSS_<desc>/migration.sql`; enum → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл — Postgres забороняє ADD VALUE + use у одній транзакції).
**Severity:** CRITICAL — TS зелений, runtime fail; tsc мовчить.

### 2026-09-06 — getLinkedCounts рахує FK-наявність, detail фільтрує deletedAt:null → count!=detail — §6/§13

**Сигнал:** новий `getLinkedCounts(orgId, ids)` рахує пов'язані сутності за самою наявністю FK (`X.purchaseOrderId ? 1 : 0`, обов'язковий FK → `1`), тоді як парний `getLinkedDocuments` робить `findFirst({ deletedAt: null })` і повертає `[]` коли реф soft-deleted. FK `ON DELETE SET NULL` спрацьовує ЛИШЕ при hard-delete → soft-delete лишає FK вказувати на мертвий рядок → badge «1», панель порожня (Bug #A/#641 count!=detail). Канонічний патерн у `invoices.getLinkedCounts` (коментар «Bug #A»); нові модулі (stock-documents/supplier-returns) його пропускали.
**Grep:** `grep -rn "getLinkedCounts" apps/api/src/modules --include="*.service.ts"` → для кожного: чи є `findMany` живих реф-id (PO/warehouse/counterparty) + `Set`-membership перед інкрементом, чи безумовне `? 1 : 0` / `= 1`. Обов'язковий FK (`warehouseId`/`supplierId`) ≠ живий → теж gate через liveness.
**Фікс:** зібрати унікальні реф-id → `findMany({ where: { id: { in: [...] }, orgId, deletedAt: null }, select: { id: true } })` → `new Set(...)` → `refId && liveSet.has(refId) ? 1 : 0` (дзеркалить invoices). +spec: soft-deleted реф → count=0.
**Severity:** IMPORTANT — badge/панель розсинхрон; німа degradation (лише коли реф soft-deleted поки документ на нього посилається).
