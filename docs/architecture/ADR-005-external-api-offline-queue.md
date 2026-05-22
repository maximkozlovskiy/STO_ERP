# ADR-005: BullMQ черга для зовнішніх API (offline tolerance)

**Дата:** 2026-05-22
**Статус:** Прийнято

## Контекст

STO ERP інтегрується з зовнішніми сервісами: TurboSMS (нотифікації), Checkbox (ПРРО), прайс-листи постачальників (ELIT, OMS, BiPoint). Всі ці виклики вимагають інтернету. Але система повинна працювати offline. Потрібен механізм, який: 1) не блокує основний потік при відсутності інтернету; 2) гарантує доставку при відновленні з'єднання.

## Вирішальна вимога

Фіскальний чек по закону повинен бути відправлений. Якщо інтернет відсутній — чек повинен відправитись автоматично при відновленні, не пізніше ніж через 24 години.

## Розглянуті варіанти

### Варіант A: Прямий HTTP виклик зі спробами (retry in-process)
**Мінуси:** При рестарті сервісу — завдання втрачається. Немає persistence.

### Варіант B: Окрема таблиця `outbox` в PostgreSQL
**Плюси:** Persistence гарантована
**Мінуси:** Потрібен окремий polling-worker, складніше ніж BullMQ

### Варіант C: BullMQ + Redis ✅
**Плюси:**
- Redis вже є в стеку (кеш + сесії)
- BullMQ: persistence, retry, backoff, dead-letter queue
- Перевірені патерни (delays, priorities, rate limiting)
- Робота при рестарті: завдання збережені в Redis
- Моніторинг через Bull Dashboard

**Мінуси:** Якщо Redis впаде разом з сервером — незавершені завдання можна втратити (вирішується через Redis AOF persistence)

## Рішення: BullMQ + Redis з AOF

### Redis налаштування (append-only persistence)
```yaml
# docker-compose.yml
redis:
  command: redis-server --appendonly yes --appendfsync everysec
  volumes:
    - redis_data:/data
```

### Черги та їх налаштування

```typescript
// apps/api/src/queues/queue.config.ts
export const QUEUES = {
  SMS:        'sms',         // TurboSMS нотифікації
  FISCAL:     'fiscal',      // Checkbox ПРРО (критично!)
  SUPPLIERS:  'suppliers',   // Оновлення прайсів
  SYNC:       'cloud-sync',  // Cloud sync (опц.)
} as const;

// Retry стратегії
export const QUEUE_OPTIONS = {
  [QUEUES.SMS]: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 }, // 1хв → 2хв → 4хв...
    removeOnComplete: 100,
  },
  [QUEUES.FISCAL]: {
    attempts: 288,  // кожні 5 хв протягом 24 годин
    backoff: { type: 'fixed', delay: 300_000 }, // 5 хвилин
    removeOnComplete: 1000,
    // Після 288 спроб → dead letter → алерт адміну
  },
  [QUEUES.SUPPLIERS]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 300_000 },
  },
};
```

### Використання (приклад — ПРРО)

```typescript
// В WorkOrdersService при переході в PAID:
await this.fiscalQueue.add(QUEUES.FISCAL, {
  workOrderId: wo.id,
  orgId: wo.orgId,
  amount: wo.totalAmount,
  paymentMethod: payment.method,
  items: lines.map(l => ({ name: l.work.name, price: l.price, qty: 1 })),
}, QUEUE_OPTIONS[QUEUES.FISCAL]);

// Worker обробляє незалежно від основного потоку:
@Processor(QUEUES.FISCAL)
export class FiscalWorker {
  @Process()
  async handle(job: Job<FiscalJobData>) {
    await this.checkboxService.createReceipt(job.data);
    // Якщо Checkbox недоступний → BullMQ автоматично retry
  }
}
```

### Dead Letter Queue — алерт адміну

```typescript
// Якщо всі спроби вичерпано → повідомити адміна системи
fiscalQueue.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    await this.notifyAdmin({
      message: `Не вдалось надіслати фіскальний чек для наряду ${job.data.workOrderId}`,
      error: err.message,
      action: 'Зайдіть у Checkbox кабінет і проведіть чек вручну',
    });
  }
});
```

## Наслідки

- Всі зовнішні API-виклики — тільки через BullMQ
- `apps/api/src/workers/` — окремий NestJS модуль для воркерів
- Redis AOF — обов'язково в production
- Bull Dashboard: `http://sto.local/admin/queues` — моніторинг для адміна
