-- AlterTable
-- IF NOT EXISTS guard: column may already exist on dev DBs that used `prisma db push`
-- before the migration was authored. Production deploys: noop is safe.
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "plannedHours" DOUBLE PRECISION;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "actualHours" DOUBLE PRECISION;
