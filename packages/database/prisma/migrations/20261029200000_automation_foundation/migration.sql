-- Автоматизація, етап 1, блок 1 — фундамент (docs/objects/automation.md, BR-AUT-*; план власника
-- 2026-10-29): outbox подій документів (domain_events), правила й спрацювання, сповіщення працівникам
-- (дзвіночок), підписки на власний Telegram-бот і одноразові коди (7 днів). Поля: згода контрагента на
-- повідомлення, тихі години й токен бота організації, журнал повідомлень з правилом і документом,
-- задача від правила (автор null = «Автоматизація») і з прив'язкою до будь-якого документа.
-- Згенеровано prisma migrate diff зі схеми HEAD до нової (без dev-бази: її ручні індекси не чіпаються).

-- CreateEnum
CREATE TYPE "AutomationDocumentType" AS ENUM ('WORK_ORDER', 'INVOICE', 'PURCHASE_ORDER', 'STOCK_DOCUMENT', 'PAYMENT', 'SUPPLIER_PAYMENT', 'SUPPLIER_RETURN', 'BOOKING', 'TASK');

-- CreateEnum
CREATE TYPE "AutomationEventKind" AS ENUM ('CREATED', 'STATUS_CHANGED');

-- CreateEnum
CREATE TYPE "AutomationMessageKind" AS ENUM ('SERVICE', 'MARKETING');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('DONE', 'PARTIAL', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'TELEGRAM_BOT';

-- AlterEnum
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'SKIPPED';

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_createdById_fkey";

-- AlterTable
ALTER TABLE "counterparties" ADD COLUMN     "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "marketingConsentById" UUID,
ADD COLUMN     "noServiceMessages" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferredChannel" "NotificationChannel";

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "quietHoursEnd" TEXT NOT NULL DEFAULT '09:00',
ADD COLUMN     "quietHoursStart" TEXT NOT NULL DEFAULT '21:00',
ADD COLUMN     "telegramBotToken" TEXT,
ADD COLUMN     "telegramBotUsername" TEXT;

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN     "counterpartyId" UUID,
ADD COLUMN     "documentId" UUID,
ADD COLUMN     "documentType" "AutomationDocumentType",
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ruleId" UUID,
ADD COLUMN     "skipReason" TEXT,
ALTER COLUMN "eventType" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "automationRuleId" UUID,
ADD COLUMN     "entityId" UUID,
ADD COLUMN     "entityType" TEXT,
ALTER COLUMN "createdById" DROP NOT NULL;

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "documentType" "AutomationDocumentType" NOT NULL,
    "documentId" UUID NOT NULL,
    "kind" "AutomationEventKind" NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "documentType" "AutomationDocumentType" NOT NULL,
    "eventKind" "AutomationEventKind" NOT NULL,
    "toStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "messageKind" "AutomationMessageKind" NOT NULL DEFAULT 'SERVICE',
    "systemKey" TEXT,
    "createdById" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "actionResults" JSONB NOT NULL DEFAULT '[]',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "documentType" "AutomationDocumentType",
    "documentId" UUID,
    "ruleId" UUID,
    "readAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "employee_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID,
    "employeeId" UUID,
    "chatId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "telegram_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_link_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "counterpartyId" UUID,
    "employeeId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_events_processedAt_occurredAt_idx" ON "domain_events"("processedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "domain_events_orgId_documentType_documentId_idx" ON "domain_events"("orgId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "domain_events_orgId_syncVersion_idx" ON "domain_events"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "automation_rules_orgId_deletedAt_idx" ON "automation_rules"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "automation_rules_orgId_documentType_eventKind_enabled_idx" ON "automation_rules"("orgId", "documentType", "eventKind", "enabled");

-- CreateIndex
CREATE INDEX "automation_rules_orgId_syncVersion_idx" ON "automation_rules"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_orgId_systemKey_key" ON "automation_rules"("orgId", "systemKey");

-- CreateIndex
CREATE INDEX "automation_runs_orgId_createdAt_idx" ON "automation_runs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_orgId_ruleId_createdAt_idx" ON "automation_runs"("orgId", "ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_orgId_syncVersion_idx" ON "automation_runs"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_ruleId_eventId_key" ON "automation_runs"("ruleId", "eventId");

-- CreateIndex
CREATE INDEX "employee_notifications_orgId_employeeId_readAt_idx" ON "employee_notifications"("orgId", "employeeId", "readAt");

-- CreateIndex
CREATE INDEX "employee_notifications_orgId_employeeId_createdAt_idx" ON "employee_notifications"("orgId", "employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "employee_notifications_orgId_syncVersion_idx" ON "employee_notifications"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_orgId_counterpartyId_active_idx" ON "telegram_subscriptions"("orgId", "counterpartyId", "active");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_orgId_employeeId_active_idx" ON "telegram_subscriptions"("orgId", "employeeId", "active");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_orgId_chatId_idx" ON "telegram_subscriptions"("orgId", "chatId");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_orgId_syncVersion_idx" ON "telegram_subscriptions"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_link_codes_code_key" ON "telegram_link_codes"("code");

-- CreateIndex
CREATE INDEX "telegram_link_codes_orgId_expiresAt_idx" ON "telegram_link_codes"("orgId", "expiresAt");

-- CreateIndex
CREATE INDEX "telegram_link_codes_orgId_syncVersion_idx" ON "telegram_link_codes"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "notification_logs_orgId_ruleId_createdAt_idx" ON "notification_logs"("orgId", "ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_logs_orgId_documentType_documentId_idx" ON "notification_logs"("orgId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "tasks_orgId_entityType_entityId_deletedAt_idx" ON "tasks"("orgId", "entityType", "entityId", "deletedAt");

-- CreateIndex
CREATE INDEX "tasks_orgId_automationRuleId_entityId_status_idx" ON "tasks"("orgId", "automationRuleId", "entityId", "status");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "domain_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

