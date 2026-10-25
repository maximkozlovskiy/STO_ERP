-- Задачі співробітникам (рішення власника 2026-10-26, docs/objects/task.md, BR-TASK-*).
--
-- Окрема таблиця, а не новий тип CalendarSlot: задача не займає підйомник і час механіка
-- (EXCLUDE-обмеження calendar_slots її не бачать) і не зменшує вільні слоти онлайн-запису
-- (BR-TASK-007). Пріоритет — наявний enum WorkOrderPriority.

CREATE TYPE "TaskStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED');

CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'NEW',
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'NORMAL',
    "assigneeId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "startAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "workOrderId" UUID,
    "vehicleId" UUID,
    "counterpartyId" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tasks_orgId_deletedAt_idx" ON "tasks"("orgId", "deletedAt");
CREATE INDEX "tasks_orgId_assigneeId_status_deletedAt_idx" ON "tasks"("orgId", "assigneeId", "status", "deletedAt");
CREATE INDEX "tasks_orgId_dueAt_idx" ON "tasks"("orgId", "dueAt");
CREATE INDEX "tasks_orgId_startAt_idx" ON "tasks"("orgId", "startAt");
CREATE INDEX "tasks_orgId_workOrderId_deletedAt_idx" ON "tasks"("orgId", "workOrderId", "deletedAt");
CREATE INDEX "tasks_orgId_syncVersion_idx" ON "tasks"("orgId", "syncVersion");

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
