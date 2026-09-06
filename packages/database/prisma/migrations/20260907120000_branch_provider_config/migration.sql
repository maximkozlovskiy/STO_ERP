-- Registry провайдерів ПРРО (Checkbox/Вчасно) та еквайрингу (monobank/LiqPay) з вибором активного
-- per-branch. Additive/idempotent — безпечно на розгорнутих БД.

-- 1. enum ProviderKind (guard: не падати якщо вже існує при повторному прогоні)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProviderKind') THEN
    CREATE TYPE "ProviderKind" AS ENUM ('FISCAL', 'PAYMENT');
  END IF;
END$$;

-- 2. CashShift.provider — яким ПРРО-провайдером відкрито зміну (токен-семантика різна)
ALTER TABLE "cash_shifts" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'checkbox';

-- 3. Таблиця конфігів провайдерів per-branch per-kind
CREATE TABLE IF NOT EXISTS "branch_provider_configs" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId"       UUID NOT NULL,
  "branchId"    UUID NOT NULL,
  "kind"        "ProviderKind" NOT NULL,
  "provider"    TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT false,
  "apiUrl"      TEXT,
  "credentials" TEXT,
  "shiftMode"   "ShiftMode" NOT NULL DEFAULT 'MANUAL',
  "syncVersion" BIGINT NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "deletedAt"   TIMESTAMP(3),
  CONSTRAINT "branch_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "branch_provider_configs_branchId_kind_provider_key"
  ON "branch_provider_configs"("branchId", "kind", "provider");
CREATE INDEX IF NOT EXISTS "branch_provider_configs_orgId_branchId_kind_idx"
  ON "branch_provider_configs"("orgId", "branchId", "kind");

-- 4. Сід НЕ-секретних конфіг-рядків з наявних BranchSettings. credentials лишаємо NULL —
-- сервіс має legacy read-fallback на старі (вже зашифровані extension-ом) колонки
-- branch_settings.checkbox*/monobank* коли credentials порожні. Так уже-налаштовані філії не
-- ламаються, а ciphertext окремих полів не потрапляє у credentials (яке шифрується цілим).
-- Idempotent через ON CONFLICT DO NOTHING по (branchId, kind, provider).
INSERT INTO "branch_provider_configs" ("orgId", "branchId", "kind", "provider", "enabled", "apiUrl", "shiftMode", "updatedAt")
SELECT bs."orgId", bs."branchId", 'FISCAL'::"ProviderKind", 'checkbox', bs."fiscalEnabled", bs."checkboxApiUrl", bs."shiftMode", CURRENT_TIMESTAMP
FROM "branch_settings" bs
WHERE bs."checkboxLicenseKey" IS NOT NULL AND bs."checkboxLicenseKey" <> ''
ON CONFLICT ("branchId", "kind", "provider") DO NOTHING;

INSERT INTO "branch_provider_configs" ("orgId", "branchId", "kind", "provider", "enabled", "apiUrl", "updatedAt")
SELECT bs."orgId", bs."branchId", 'PAYMENT'::"ProviderKind", 'monobank', true, bs."monobankApiUrl", CURRENT_TIMESTAMP
FROM "branch_settings" bs
WHERE bs."monobankToken" IS NOT NULL AND bs."monobankToken" <> ''
ON CONFLICT ("branchId", "kind", "provider") DO NOTHING;
