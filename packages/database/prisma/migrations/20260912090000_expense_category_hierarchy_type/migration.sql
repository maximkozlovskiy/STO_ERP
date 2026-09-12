-- Статті руху коштів: ієрархія (parentId) + тип (EXPENSE/INCOME) + sortOrder/isActive (additive).
-- CreateEnum
CREATE TYPE "ExpenseCategoryType" AS ENUM ('EXPENSE', 'INCOME');

-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parentId" UUID,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "type" "ExpenseCategoryType" NOT NULL DEFAULT 'EXPENSE';

-- CreateIndex
CREATE INDEX "expense_categories_orgId_parentId_idx" ON "expense_categories"("orgId", "parentId");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
