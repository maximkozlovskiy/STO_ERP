-- Email-канал: NotificationLog.phone → recipient (email або телефон). Idempotent rename.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_logs' AND column_name = 'phone'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_logs' AND column_name = 'recipient'
  ) THEN
    ALTER TABLE "notification_logs" RENAME COLUMN "phone" TO "recipient";
  END IF;
END $$;
