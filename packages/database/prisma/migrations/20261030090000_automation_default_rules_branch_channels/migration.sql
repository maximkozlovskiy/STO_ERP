-- Автоматизація — типові правила (docs/objects/automation.md, BR-AUT-007, 011, 014).
-- 1) Канали — «як у налаштуваннях філії» (рішення власника 2026-10-29: «Я налаштовую самостійно
--    пріоритет, немає фіксованих»): з дії «повідомлення клієнту» типового правила прибирається
--    фіксований ланцюжок Viber → SMS — лише якщо він саме такий (власник міг змінити).
-- 2) Bug #998: порожній телефон організації давав «…Головна філія, тел. ». Хвіст — у
--    необов'язковому фрагменті `[[, тел. {{branchPhone}}]]`: замінюється лише тіло, що дорівнює
--    старому типовому дослівно (змінений власником текст не чіпаємо).
-- Нові тексти — AUTOMATION_DEFAULT_RULES з @sto/shared (паритет стереже
-- automation.default-rules.spec.ts). Повторний запуск нічого не змінює. Лише дані.

WITH legacy ("systemKey", "oldBody", "newBody") AS (VALUES
  ('WO_COMPLETED_CLIENT', 'Вітаємо, {{clientName}}! Ваш автомобіль {{vehicle}} готовий до видачі (наряд {{documentNumber}}, сума {{totalAmount}}). {{branchName}}, тел. {{branchPhone}}', 'Вітаємо, {{clientName}}! Ваш автомобіль {{vehicle}} готовий до видачі (наряд {{documentNumber}}, сума {{totalAmount}}). {{branchName}}[[, тел. {{branchPhone}}]]'),
  ('PAYMENT_CREATED_CLIENT', 'Дякуємо, {{clientName}}! Оплату {{totalAmount}} отримано {{date}} о {{time}}. {{branchName}}, тел. {{branchPhone}}', 'Дякуємо, {{clientName}}! Оплату {{totalAmount}} отримано {{date}} о {{time}}. {{branchName}}[[, тел. {{branchPhone}}]]'),
  ('BOOKING_CREATED_CLIENT', 'Вітаємо, {{clientName}}! Запис на {{visitDate}} о {{visitTime}} прийнято. Чекаємо на вас у {{branchName}}, тел. {{branchPhone}}', 'Вітаємо, {{clientName}}! Запис на {{visitDate}} о {{visitTime}} прийнято. Чекаємо на вас у {{branchName}}[[, тел. {{branchPhone}}]]')
)
UPDATE "automation_rules" r
SET "actions" = (
      SELECT jsonb_agg(
        CASE WHEN e.a->>'type' = 'client_message' THEN
          (CASE WHEN e.a->'channels' = '["VIBER","SMS"]'::jsonb THEN e.a - 'channels' ELSE e.a END)
          || CASE WHEN e.a->'template'->>'body' = l."oldBody"
               THEN jsonb_build_object('template', jsonb_set(e.a->'template', '{body}', to_jsonb(l."newBody")))
               ELSE '{}'::jsonb
             END
        ELSE e.a END
        ORDER BY e.ord)
      FROM jsonb_array_elements(r."actions") WITH ORDINALITY AS e(a, ord)
    ),
    "syncVersion" = r."syncVersion" + 1,
    "updatedAt" = now()
FROM legacy l
WHERE r."systemKey" = l."systemKey"
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(r."actions") AS x(a)
    WHERE x.a->>'type' = 'client_message'
      AND (x.a->'channels' = '["VIBER","SMS"]'::jsonb OR x.a->'template'->>'body' = l."oldBody")
  );
