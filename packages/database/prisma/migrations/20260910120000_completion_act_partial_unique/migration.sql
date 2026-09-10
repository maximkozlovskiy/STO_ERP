-- R1 (pre-prod re-review): CompletionAct — plain @@unique([orgId, number]) → partial-unique
-- (orgId, number) WHERE deletedAt IS NULL. Узгодження з 7 документними таблицями T14
-- (20260909210000): soft-deleted акт виконаних робіт більше не блокує повторне видання номера.
--
-- Було: constraint completion_acts_orgId_number_key рахував і soft-deleted рядки → після soft-delete
-- акта DocumentNumberService повторне видання того самого номера падало на P2002.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS. Additive для даних
-- (partial-unique слабший за plain — жодного нового конфлікту на існуючих активних рядках, бо вони
-- вже були унікальні під суворішим plain-констрейнтом).

ALTER TABLE "completion_acts" DROP CONSTRAINT IF EXISTS "completion_acts_orgId_number_key";

CREATE UNIQUE INDEX IF NOT EXISTS "completion_acts_orgId_number_active_uq"
  ON "completion_acts" ("orgId", "number") WHERE "deletedAt" IS NULL;
