-- Add FOLLOWUP_REMINDER to NotificationEventType enum
ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'FOLLOWUP_REMINDER';
