-- Bug #506: routing booking-widget SMS through NotificationsService.send() (single
-- source of truth for branchSettings provider/apiKey + notificationTemplate body).
-- Add BOOKING_CONFIRMATION to NotificationEventType enum.
-- IF NOT EXISTS guard mirrors 20260526230000_add_followup_reminder_event pattern.
ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'BOOKING_CONFIRMATION';

-- Note: NotificationTemplate seed для нового eventType винесено у seed.ts —
-- Postgres вимагає окремий commit між ADD VALUE та INSERT що його використовує.
