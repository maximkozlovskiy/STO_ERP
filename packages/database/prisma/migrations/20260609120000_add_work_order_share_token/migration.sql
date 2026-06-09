-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_shareToken_key" ON "work_orders"("shareToken");
