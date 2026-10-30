-- Шаблон кошторису (WO_ESTIMATE_READY): {{totalAmount}} з 2026-10-30 приходить уже з одиницею
-- («1 800,00 грн», документ у доларах — «100,00 USD»), тож « грн» після змінної дає «грн грн».
-- Прибираємо лише точний фрагмент «{{totalAmount}} грн» — решту тексту, змінену власником, не чіпаємо.
UPDATE "notification_templates"
SET "body" = REPLACE("body", '{{totalAmount}} грн', '{{totalAmount}}'),
    "updatedAt" = now()
WHERE "eventType" = 'WO_ESTIMATE_READY'::"NotificationEventType"
  AND "body" LIKE '%{{totalAmount}} грн%';
