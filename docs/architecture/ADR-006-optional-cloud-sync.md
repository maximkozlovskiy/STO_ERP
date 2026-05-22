# ADR-006: Опціональна Cloud Sync через Outbox Pattern

**Дата:** 2026-05-22
**Статус:** Прийнято

## Контекст

Деякі клієнти захочуть:
1. Автоматичний резервний backup у хмару
2. Клієнтський web-кабінет (онлайн-запис, статус авто)
3. Консолідовану звітність по кількох філіях

Це не потрібно для MVP, але архітектура повинна підтримувати це з мінімальним рефакторингом.

## Вимоги

- Локальна система не залежить від cloud: якщо sync-сервер недоступний — нічого не ламається
- Cloud отримує дані eventual consistency (не real-time)
- Конфлікти між філіями вирішуються детерміновано
- Можливість відновлення локальної БД з cloud backup

## Рішення: Outbox Pattern + Delta Sync

### Механізм

```
Кожна мутація в local PostgreSQL:
  1. Записує бізнес-об'єкт (WorkOrder, StockMovement, etc.)
  2. Записує запис в event_outbox (append-only):
     { id, org_id, entity_type, entity_id, payload_json, created_at, sent_at NULL }

BullMQ worker (кожні 30 сек):
  SELECT * FROM event_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 100
  → POST /sync/push до Cloud Hub
  → UPDATE event_outbox SET sent_at = NOW() де успішно
```

### Sync-ready поля (вже в кожній таблиці)

```prisma
syncVersion BigInt @default(0)  // інкремент при кожній зміні
// Prisma middleware:
prisma.$use(async (params, next) => {
  const result = await next(params);
  if (['create','update','delete'].includes(params.action)) {
    await prisma.$executeRaw`
      UPDATE ${params.model} SET sync_version = sync_version + 1
      WHERE id = ${result.id}
    `;
  }
  return result;
});
```

### Delta sync endpoint (для mobile і майбутнього cloud)

```typescript
// GET /sync/pull?lastSyncVersion=12345&orgId=...
// Повертає тільки змінені записи — ефективно для великих БД
SELECT * FROM work_orders
WHERE org_id = $1 AND sync_version > $2
ORDER BY sync_version ASC
LIMIT 500;
```

### Conflict Resolution

| Тип даних | Стратегія |
|-----------|-----------|
| WorkOrder status | Last-write-wins по `updated_at` |
| StockMovement | Append-only, конфліктів немає |
| SettlementTransaction | Append-only, конфліктів немає |
| Employee/Catalog | Last-write-wins по `updated_at` |
| Vehicle mileage | Max value wins |

### Cloud Sync Hub (Phase 2)

```
Cloud Hub — окремий NestJS сервіс (Fly.io або власний VPS):
  POST /sync/push   ← отримує події від локальних інсталяцій
  GET  /sync/pull   ← видає дельту для клієнтського порталу
  PostgreSQL        ← consolidated event_log (append-only)
  Materialized views ← для аналітики по всіх філіях
```

## Наслідки

- `event_outbox` таблиця — в кожній локальній БД з MVP
- `syncVersion` — в кожній таблиці з MVP
- Cloud sync активується через конфіг, не рефакторинг
- Без cloud API-ключа — sync worker просто нічого не робить
