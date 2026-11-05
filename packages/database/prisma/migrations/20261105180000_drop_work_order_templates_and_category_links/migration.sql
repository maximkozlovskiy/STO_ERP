-- Дві мертві таблиці без коду, що їх читає чи пише (TECH-DEBT (а)).
--
-- work_good_category_links — зв'язки «категорія робіт ↔ категорія товарів». Наповнював лише
-- seed-catalog, read-endpoint-и прибрано 2026-10-30 (BR-WORK-004). Дані — похідні від JSON каталогу,
-- нічого користувацького.
--
-- work_order_templates — шаблони нарядів. Міграція 20261030190000_work_order_templates_to_services
-- перенесла кожен невидалений шаблон у послугу каталогу й позначила шаблон видаленим; API
-- `/work-order-templates` прибрано тоді ж (BR-WO-036). Синк мобільного застосунку таблицю не читає.
DROP TABLE "work_good_category_links"; -- destructive-ok: мертва таблиця, зв'язки лише з seed, коду немає (BR-WORK-004)
DROP TABLE "work_order_templates"; -- destructive-ok: шаблони вже перенесено в послуги міграцією 20261030190000 (BR-WO-036)
