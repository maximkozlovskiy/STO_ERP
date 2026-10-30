-- Власний Telegram-бот (BR-AUT-041): offset long polling `getUpdates` — наступний update_id, щоб
-- оновлення (/start, /stop) не оброблялись повторно після рестарту api.
ALTER TABLE "organisation_settings" ADD COLUMN "telegramBotUpdateOffset" BIGINT;
