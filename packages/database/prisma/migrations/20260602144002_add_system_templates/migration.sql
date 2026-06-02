-- CreateTable
CREATE TABLE "system_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entityType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "system_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_templates_entityType_sortOrder_idx" ON "system_templates"("entityType", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "system_templates_entityType_key_key" ON "system_templates"("entityType", "key");
