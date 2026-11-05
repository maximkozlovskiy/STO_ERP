-- Завершення batch-у пропозицій (`completeBatchIfDone`) після кожного запиту питає «чи лишився
-- відкритий запит batch-у». З індексом (orgId, batchId) Postgres перебирав усі рядки batch-у щоразу —
-- O(N²) на batch (TECH-DEBT (а) §15 п. 8). Новий індекс із status знаходить відкритий рядок одразу;
-- його префікс (orgId, batchId) обслуговує й читання batch-у, тому старий індекс зайвий.
-- Спершу новий, потім старий — без проміжку, коли batch-запити йдуть без індексу.
CREATE INDEX "supplier_offer_requests_orgId_batchId_status_idx" ON "supplier_offer_requests"("orgId", "batchId", "status");
DROP INDEX "supplier_offer_requests_orgId_batchId_idx";
