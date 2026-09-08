-- Covering-індекс під головний UI-фільтр IntegrationLogService.findAll:
--   WHERE ("orgId", "provider") ORDER BY "createdAt" DESC
-- Provider-дропдаун — домінантний фільтр адмін-таба логів. Наявний (orgId, createdAt)-індекс
-- НЕ покриває provider-рівність → org-wide scan усіх логів орг у createdAt-порядку + heap-filter.
-- (orgId, provider, createdAt): provider equality leftmost, createdAt range/sort у tail →
-- index-range scan + готовий порядок (без external sort). Additive/idempotent, deploy-safe.

CREATE INDEX IF NOT EXISTS "integration_logs_orgId_provider_createdAt_idx"
  ON "integration_logs" ("orgId", "provider", "createdAt");
