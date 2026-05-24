-- AlterTable
ALTER TABLE "branch_settings" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "notification_templates" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payment_method_configs" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "settlement_accounts" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;
