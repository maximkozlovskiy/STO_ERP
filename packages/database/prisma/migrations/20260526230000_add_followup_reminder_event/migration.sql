-- Add FOLLOWUP_REMINDER to NotificationEventType enum
ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'FOLLOWUP_REMINDER';

-- Defer template seeding to a separate migration so the new enum value is
-- committed before being used (Postgres requires this when both happen in
-- one migration file).
