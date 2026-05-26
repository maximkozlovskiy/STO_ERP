-- B6: pg_trgm extension + GIN indexes for full-text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_work_orders_number_trgm ON work_orders USING gin ("number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_counterparties_firstname_trgm ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_counterparties_lastname_trgm ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_counterparties_phone_trgm ON counterparties USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_goods_name_trgm ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_goods_sku_trgm ON goods USING gin (sku gin_trgm_ops);

-- B10: EmployeeBranch M:M table
CREATE TABLE "employee_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_branches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employee_branches_employeeId_branchId_key" ON "employee_branches"("employeeId", "branchId");
CREATE INDEX "employee_branches_orgId_idx" ON "employee_branches"("orgId");
CREATE INDEX "employee_branches_employeeId_idx" ON "employee_branches"("employeeId");

ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- B10: allBranches flag on employees
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "allBranches" BOOLEAN NOT NULL DEFAULT false;

-- F8: Comments model
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comments_orgId_entityType_entityId_createdAt_idx" ON "comments"("orgId", "entityType", "entityId", "createdAt");
CREATE INDEX "comments_syncVersion_idx" ON "comments"("orgId", "syncVersion");

ALTER TABLE "comments" ADD CONSTRAINT "comments_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- F10: WorkOrderTemplate model
CREATE TABLE "work_order_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "parts" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "work_order_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_order_templates_orgId_deletedAt_idx" ON "work_order_templates"("orgId", "deletedAt");

ALTER TABLE "work_order_templates" ADD CONSTRAINT "work_order_templates_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
