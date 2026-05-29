-- Add counterpartyId to CalendarSlot so a client can be linked directly
-- to a calendar slot without requiring a work order.
ALTER TABLE "calendar_slots"
  ADD COLUMN "counterpartyId" UUID REFERENCES "counterparties"("id") ON DELETE SET NULL;

CREATE INDEX "calendar_slots_org_counterparty_idx"
  ON "calendar_slots" ("orgId", "counterpartyId")
  WHERE "deletedAt" IS NULL;
