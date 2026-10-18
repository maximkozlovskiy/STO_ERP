-- Пропозиції позиції списку купівлі (`GET /purchase-list-items/:id/offers`, вибір пропозиції) шукаються за
-- (orgId, purchaseListItemId). Без індексу — паралельний повний скан supplier_offer_requests разом із
-- рядками, видаленими за retention; EXPLAIN на 450 тис. рядків: 24.8–26.9 мс → 0.09 мс (optimize 2026-10-18).
CREATE INDEX IF NOT EXISTS "supplier_offer_requests_orgId_purchaseListItemId_idx"
    ON "supplier_offer_requests"("orgId", "purchaseListItemId");
