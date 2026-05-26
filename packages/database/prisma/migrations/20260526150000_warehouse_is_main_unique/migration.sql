-- Partial unique index — guarantees at most ONE main warehouse per organisation
-- at the database layer. Without this constraint, the service-layer pattern
--   `await tx.warehouse.updateMany({ isMain: false }); await tx.warehouse.create({ isMain: true });`
-- has a race window: two parallel transactions in READ COMMITTED both run
-- updateMany (row-locks on EXISTING rows only), then both create new rows
-- (no conflict on inserts), leaving 2+ warehouses with isMain=true.
--
-- The index includes `deletedAt IS NULL` so soft-deleted warehouses with
-- isMain=true do not block restoring/creating a new main warehouse.
--
-- The Prisma schema cannot model partial unique indexes (Prisma supports
-- @@unique without conditions only), so this is intentionally raw SQL.
-- The service-layer guard remains for UX (sets others to isMain=false),
-- this index is the authoritative invariant.

CREATE UNIQUE INDEX IF NOT EXISTS "warehouses_orgId_isMain_unique"
  ON "warehouses" ("orgId")
  WHERE "isMain" = true AND "deletedAt" IS NULL;
