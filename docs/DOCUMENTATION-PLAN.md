# STO ERP — План документації

> Що потрібно створити для якісної роботи з Claude Code

---

## Пріоритет 1 — КРИТИЧНО для Claude Code (робити першими)

### 1.1 ERD — Entity-Relationship Diagram
**Файл:** `docs/architecture/ERD.md` (Mermaid діаграма)  
**Чому важливо:** Claude бачить всі зв'язки між таблицями одним поглядом. Без ERD кожного разу потрібно читати весь schema.prisma і будувати модель у голові.

```mermaid
erDiagram
  Organization ||--o{ WorkOrder : "має"
  WorkOrder ||--o{ WorkOrderLine : "складається з"
  WorkOrderLine }o--|| CatalogItem : "посилається"
  ...
```

**Що включити:** всі 25+ моделей, кардинальність зв'язків, ключові поля (id, orgId, deletedAt), виділити кольором append-only таблиці (StockMovement, SettlementTransaction).

---

### 1.2 FSM діаграми — скінченні автомати
**Файл:** `docs/architecture/FSM.md`  
**Чому важливо:** Claude повинен знати дозволені переходи щоб не генерувати код з невалідними transition'ами.

Потрібні FSM для:
- **WorkOrder:** Draft → Estimate → Approved → InProgress → OnHold → Completed → Invoiced → Paid → Archived
- **StockDocument:** Draft → Confirmed → Cancelled
- **SettlementDocument:** Draft → Posted → Voided
- **SyncJob:** Pending → InProgress → Completed | Failed | Retrying

Для кожного: стани, переходи, guard-умови, side effects (events що емітяться), хто має право на перехід (RBAC).

---

### 1.3 RBAC матриця
**Файл:** `docs/architecture/RBAC-MATRIX.md`  
**Чому важливо:** Без явної матриці Claude може забути перевірку ролей або додати занадто широкий доступ.

| Дія | OWNER | ADMIN | RECEPTIONIST | MECHANIC | STOREKEEPER | ACCOUNTANT |
|-----|-------|-------|--------------|----------|-------------|------------|
| Створити наряд | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Закрити наряд | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Прийом ТМЦ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| ... | | | | | | |

---

### 1.4 Environment Variables Reference
**Файл:** `docs/ENV-REFERENCE.md`  
**Чому важливо:** Claude генерує правильні назви змінних; не плутає dev/prod значення.

```markdown
## apps/api/.env
| Змінна | Тип | Обов'язкова | Опис | Приклад |
|--------|-----|-------------|------|---------|
| DATABASE_URL | string | ✅ | PostgreSQL connection string | postgresql://sto:pass@localhost:5432/sto_erp |
| REDIS_URL | string | ✅ | Redis connection string | redis://localhost:6379 |
| JWT_ACCESS_SECRET | string | ✅ | Секрет для access токенів (мін 32 символи) | ... |
| CHECKBOX_API_URL | string | ✅ | Checkbox ПРРО endpoint | https://api.checkbox.in.ua/api/v1 |
| CHECKBOX_LICENSE_KEY | string | ✅ | Ліцензійний ключ ПРРО | ... |
| SMS_PROVIDER | enum | ✅ | turbosms / alphasms / kyivstar | turbosms |
| TURBOSMS_TOKEN | string | якщо turbosms | Bearer токен TurboSMS | ... |
...
```

---

## Пріоритет 2 — ВАЖЛИВО для консистентності

### 2.1 API Contract (OpenAPI spec)
**Файл:** `docs/api/openapi.yaml` або автогенерується з NestJS Swagger  
**Підхід:** NestJS генерує Swagger автоматично, але потрібно задокументувати:
- Конвенції URL: `GET /work-orders`, `POST /work-orders/:id/transition`
- Стандартні помилки: формат `{ code: string, message: string, details?: object }`
- Пагінація: `{ items: T[], total: number, page: number, limit: number }`
- Дати: завжди ISO 8601 UTC у API, конвертація у Kyiv timezone на клієнті

**Файл:** `docs/api/CONVENTIONS.md`

---

### 2.2 UI Design Tokens / Style Guide
**Файл:** `docs/ui/DESIGN-TOKENS.md`  
**Що включити:**
- Кольорова палітра (primary, success, warning, error, neutral)
- Типографіка (розміри, font-family)
- Відступи (spacing scale)
- Ключові UI-патерни: форми, таблиці, модалки, сповіщення
- Формати відображення: дати `DD.MM.YYYY`, суми `1 250,00 ₴`, телефони `+380 67 123 45 67`
- Стани завантаження (skeleton, spinner)

---

### 2.3 Testing Strategy
**Файл:** `docs/TESTING-STRATEGY.md`  
**Що включити:**

```markdown
## Тестова піраміда

### Unit tests (Vitest) — 70%
- Service методи з мокованим Prisma
- FSM transitions — всі можливі шляхи
- Бізнес-правила (розрахунки, валідації)
- Покриття: >80% для services

### Integration tests (Supertest) — 20%
- HTTP endpoints зі справжньою тестовою БД
- Auth flow (login, refresh, logout)
- Критичні бізнес-сценарії end-to-end

### E2E tests (Playwright) — 10%
- Головні user journeys:
  1. Створення наряду → завершення → виставлення рахунку
  2. Прийом товару → списання на наряд
  3. Розрахунок з клієнтом → квитанція
```

---

### 2.4 Git Workflow
**Файл:** `docs/GIT-WORKFLOW.md`  
**Що включити:**
- Branch strategy: `main` (prod) ← `develop` ← `feature/`, `fix/`, `chore/`
- Commit convention: `feat(work-orders): додати перехід InProgress→OnHold`
- PR шаблон: опис, тести, скріншоти UI (якщо є)
- Заборона: прямий push у main/develop

---

## Пріоритет 2.5 — ФІНАНСОВА ЛОГІКА (перед реалізацією модулів розрахунків)

> ⚠️ Ці документи відсутні і можуть призвести до тихих помилок у фінансових розрахунках.  
> Створити до початку реалізації модулів `settlements`, `work-orders` (totals), `inventory`.

### 2.5.1 Формули розрахунків
**Файл:** `docs/CALCULATION-RULES.md`  
**Чому критично:** Claude не знає як рахувати суми і може зробити неправильну реалізацію, яка дасть невірні фінансові дані без явних помилок.  
**Що описати:**
- `WorkOrderLine.amount` = `normoHours × price` чи `price` вже фінальна сума?
- `WorkOrder.totalLabor` = сума `line.amount`; `totalParts` = сума `part.amount`; `totalAmount` = їх сума
- `Employee.rateScheme` JSON — розписати обидві схеми з формулами:
  - `percent_normo`: відсоток від якої бази (від `line.amount`? від норм-ставки?)
  - `fixed_plus_bonus`: fixed per day/month + формула бонусу
- Знак транзакцій `SettlementTransaction.amount`: яке число позитивне при `CHARGE`, `PAYMENT`, `REFUND`
- Логіка знижок: чи є знижка на наряд? Де зберігається?
- ПДВ: як впливає `Counterparty.vatPayer` на відображення цін?

### 2.5.2 Автонумерація документів ← ОКРЕМИЙ МОДУЛЬ
**Статус:** Концепт закладено в схему БД (модель `DocumentNumberConfig`). Файл специфікації не потрібен — логіка описана в ERD + бізнес-правилах.

**Концепт:**  
Автонумерація — окремий керований модуль `DocumentNumberingService`. Кожна організація налаштовує формат номера для кожного типу документа через UI.

**Формат за замовчуванням:** `{Префікс}-{Дата}-{Порядковий номер}`  
Приклад: `СТО-20240521-000001`

**Складові (всі опціональні, крім порядкового номера):**
| Частина | За замовч. | Приклад | Керується |
|---------|------------|---------|-----------|
| Префікс організації | `""` (порожньо) | `СТО`, `АВТО` | Поле в налаштуваннях |
| Дата/час | увімкнено | `20240521` | Формат: `YYYY`, `YYYYMM`, `YYYYMMDD` |
| Порядковий номер | 6 цифр | `000001` | Кількість знаків, скидання: ніколи / щороку / щомісяця |
| Роздільник | `-` | `СТО-20240521-000001` | Символ між частинами |

**Типи документів** (enum `DocumentType`):
- `WORK_ORDER` — Наряди
- `INVOICE` — Рахунки
- `PURCHASE_ORDER` — Замовлення постачальнику
- `STOCK_RECEIPT` — Прихід товару (від постачальника)
- `STOCK_WRITEOFF` — Списання ТМЦ
- `STOCK_TRANSFER` — Переміщення між складами
- `STOCK_OPENING` — Введення початкових залишків
- `RECONCILIATION_ACT` — Акт звірки

**Атомарність:** лічильник збільшується через `SELECT ... FOR UPDATE` або PostgreSQL sequence — без дублікатів навіть при паралельних запитах.

### 2.5.3 Початкові дані та налаштування системи
**Підхід:** Все вноситься вручну через UI. Немає прихованих seed-даних. Максимальна керованість.

**При першому запуску — майстер налаштування (Wizard):**
1. Створення OWNER-облікового запису (логін + пароль)
2. Дані організації (назва, ЄДРПОУ, адреса)
3. Перша філія + перший склад (тип MAIN)
4. Налаштування ПРРО (Checkbox ключ, PIN касира) — або пропустити
5. Налаштування SMS-провайдера — або пропустити
6. Пропозиція завантажити стандартний каталог робіт (опціонально)

**Початкові залишки ТМЦ — через документ типу `STOCK_OPENING`:**  
Стандартний складський документ зі статусом DRAFT → CONFIRMED.  
При підтвердженні створює `StockMovement(OPENING_BALANCE)` для кожного рядка.  
Підтримує масовий імпорт з Excel (майбутня фіча).

**Стандартний каталог робіт — опціональний імпорт:**  
Вбудований JSON-файл зі стандартними категоріями та роботами для СТО.  
Адміністратор може завантажити його через UI одним кліком або ввести вручну.

---

## Пріоритет 3 — КОРИСНО для операційної готовності

### 3.1 Backup & Recovery Runbook
**Файл:** `docs/operations/BACKUP-RECOVERY.md`  
- Що бекапиться: PostgreSQL (pg_dump) + MinIO дані
- Розклад: щодня о 02:00, зберігати 30 днів
- Де зберігати: локально + опційно USB/мережева папка
- Процедура відновлення: крок за кроком для нетехнічного персоналу

### 3.2 Monitoring Plan
**Файл:** `docs/operations/MONITORING.md`  
- Локальний стек: Prometheus + Grafana (вже в docker-compose)
- Ключові метрики: CPU/RAM контейнерів, довжина черг BullMQ, помилки ПРРО
- Алерти: email/Viber через BullMQ при критичних помилках
- Логи: Loki або просто файли в `logs/` з ротацією

### 3.3 Data Migration Strategy  
**Файл:** `docs/DATA-MIGRATION.md`  
- Як застосовувати міграції при оновленні: `prisma migrate deploy` до старту застосунку
- Rollback стратегія: резервна копія БД перед міграцією
- Handling breaking changes: rename column через дві міграції (add new → migrate data → drop old)

---

## Пріоритет 4 — ДЛЯ МАСШТАБУВАННЯ

### 4.1 Cloud Sync Technical Spec
**Файл:** `docs/architecture/CLOUD-SYNC-SPEC.md`  
Детальний технічний опис Outbox Pattern + conflict resolution:
- Алгоритм sync: pull changes (syncVersion > lastSynced) → merge → push local changes
- Conflict resolution table (per entity)
- Security: end-to-end encryption, tenant isolation в хмарі

### 4.2 Scalability Roadmap
**Файл:** `docs/architecture/SCALABILITY-ROADMAP.md`  
- MVP (local Docker): 1 org, 1-20 users, 1 server
- Multi-org SaaS: окремі Docker namespace per org АБО shared DB з tenant isolation
- Micro-services path: які модулі виносяться першими (Notifications, Sync, Reports)

---

## Рекомендований порядок створення

```
Тиждень 1 (перед кодингом):
  ├── ERD.md               ← Схема БД у вигляді діаграми
  ├── FSM.md               ← Автомати станів
  ├── RBAC-MATRIX.md       ← Матриця доступу
  └── ENV-REFERENCE.md     ← Всі змінні середовища

Тиждень 2 (паралельно з Phase 0):
  ├── api/CONVENTIONS.md   ← API патерни
  ├── TESTING-STRATEGY.md  ← Тестова стратегія
  └── GIT-WORKFLOW.md      ← Workflow команди

Перед модулями розрахунків (settlements, work-orders totals):
  └── CALCULATION-RULES.md    ← формули сум, rateScheme, знаки транзакцій
  (автонумерація — в ERD + BR-NUM-*; початкові дані — через UI Wizard)

Після MVP (перед першим деплоєм у клієнта):
  ├── BACKUP-RECOVERY.md
  ├── MONITORING.md
  └── DATA-MIGRATION.md
```

---

## Додаткові скіли для Claude Code

Рекомендую створити ще два скіли:

### `/sto-ops` — Операційний скіл
Для задач: деплой, backup, update, monitoring. Включає команди docker, скрипти Update.ps1/Backup.ps1, процедури відновлення.

### `/sto-sync` — Cloud Sync скіл  
Для реалізації Phase 5 (cloud sync). Включає Outbox Pattern, conflict resolution алгоритми, API синхронізації.
