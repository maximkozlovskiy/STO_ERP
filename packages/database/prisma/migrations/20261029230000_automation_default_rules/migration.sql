-- Автоматизація, блок 2 — типові правила організації (docs/objects/automation.md, BR-AUT-007).
-- Замінюють зашиті повідомлення клієнту: наряд «Виконано», оплату отримано, онлайн-запис створено
-- (виклики з work-order.handlers / payments.service / booking.service прибрано). Кожній наявній
-- організації — ті самі правила, що setup.service створює новій (AUTOMATION_DEFAULT_RULES з
-- @sto/shared; паритет тексту стереже automation.default-rules.spec.ts). Повторний запуск нічого
-- не дублює: (orgId, systemKey) унікальний.
-- Кнопка «Надіслати кошторис» лишається ручною — організаціям без шаблону WO_ESTIMATE_READY / SMS
-- додається шаблон з усіма змінними, які передає WorkOrderShareService.
-- Лише дані, схема не змінюється.

INSERT INTO "automation_rules" (
  "orgId", "systemKey", "name", "enabled", "documentType", "eventKind", "toStatuses",
  "messageKind", "conditions", "actions", "updatedAt"
)
SELECT o."id", v."systemKey", v."name", true, v."documentType"::"AutomationDocumentType",
  v."eventKind"::"AutomationEventKind", v."toStatuses"::text[],
  v."messageKind"::"AutomationMessageKind", '{}'::jsonb, v."actions"::jsonb, now()
FROM "organisations" o
CROSS JOIN (VALUES
  ('WO_COMPLETED_CLIENT', 'Наряд виконано — повідомити клієнта', 'WORK_ORDER', 'STATUS_CHANGED', '{COMPLETED}', 'SERVICE', '[{"type":"client_message","channels":["VIBER","SMS"],"template":{"body":"Вітаємо, {{clientName}}! Ваш автомобіль {{vehicle}} готовий до видачі (наряд {{documentNumber}}, сума {{totalAmount}}). {{branchName}}, тел. {{branchPhone}}"}}]'),
  ('PAYMENT_CREATED_CLIENT', 'Оплату отримано — повідомити клієнта', 'PAYMENT', 'CREATED', '{}', 'SERVICE', '[{"type":"client_message","channels":["VIBER","SMS"],"template":{"body":"Дякуємо, {{clientName}}! Оплату {{totalAmount}} отримано {{date}} о {{time}}. {{branchName}}, тел. {{branchPhone}}"}}]'),
  ('BOOKING_CREATED_CLIENT', 'Онлайн-запис створено — підтвердити клієнту', 'BOOKING', 'CREATED', '{}', 'SERVICE', '[{"type":"client_message","channels":["VIBER","SMS"],"template":{"body":"Вітаємо, {{clientName}}! Запис на {{visitDate}} о {{visitTime}} прийнято. Чекаємо на вас у {{branchName}}, тел. {{branchPhone}}"}}]')
) AS v("systemKey", "name", "documentType", "eventKind", "toStatuses", "messageKind", "actions")
WHERE o."deletedAt" IS NULL
ON CONFLICT ("orgId", "systemKey") DO NOTHING;

INSERT INTO "notification_templates" ("orgId", "eventType", "channel", "body", "isActive", "updatedAt")
SELECT o."id", 'WO_ESTIMATE_READY'::"NotificationEventType", 'SMS'::"NotificationChannel",
  '{{clientName}}, кошторис {{woNumber}} на ремонт {{vehiclePlate}} готовий. Сума: {{totalAmount}} грн. Деталі: {{link}}', true, now()
FROM "organisations" o
WHERE o."deletedAt" IS NULL
ON CONFLICT ("orgId", "eventType", "channel") DO NOTHING;
