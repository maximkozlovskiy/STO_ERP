# ADR-005: BullMQ черга для зовнішніх API (offline tolerance)

**Дата:** 2026-05-22 · оновлено 2026-10-18 (див. «Стан на 2026-10-18»)
**Статус:** Прийнято

> Приклади коду нижче (`QUEUES`, `QUEUE_OPTIONS`, `fiscal`, `suppliers`) — первісний задум 2026-05.
> Чинні правила, назви черг і сторож — у розділі «Стан на 2026-10-18» наприкінці.

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
  SMS: 'sms', // TurboSMS нотифікації
  FISCAL: 'fiscal', // Checkbox ПРРО (критично!)
  SUPPLIERS: 'suppliers', // Оновлення прайсів
  SYNC: 'cloud-sync', // Cloud sync (опц.)
} as const;

// Retry стратегії
export const QUEUE_OPTIONS = {
  [QUEUES.SMS]: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 }, // 1хв → 2хв → 4хв...
    removeOnComplete: 100,
  },
  [QUEUES.FISCAL]: {
    attempts: 288, // кожні 5 хв протягом 24 годин
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
await this.fiscalQueue.add(
  QUEUES.FISCAL,
  {
    workOrderId: wo.id,
    orgId: wo.orgId,
    amount: wo.totalAmount,
    paymentMethod: payment.method,
    items: lines.map(l => ({ name: l.work.name, price: l.price, qty: 1 })),
  },
  QUEUE_OPTIONS[QUEUES.FISCAL],
);

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

## Стан на 2026-10-18 (чинні правила)

**Повтори — у кожному `.add()`, літералами.** Кожна задача черги зовнішнього API — `attempts: 10`
(не менше) і `backoff: { type: 'exponential', delay: <мс> }` прямо в третьому аргументі `queue.add()`;
ПРРО (`checkbox`) — `attempts: 288` + експоненційний backoff від 5 хв (≈24 год). `registerQueue`
отримує лише спільний `DEFAULT_JOB_OPTS` (утримання job-ів), повтори в дефолтах черги не задаються.
Сторож — `apps/api/src/modules/payments/payments.queue-retry-policy.spec.ts`: TypeScript-парсером читає
всі `add()` і НЕ розуміє констант (`attempts: MAX` — порушення), рахує їх по чергах (census) і вимагає,
щоб кожна черга з коду була класифікована. Старі порушення — у `KNOWN_VIOLATIONS` того ж файла.

**Черги** (джерело правди — `EXTERNAL_API_QUEUES` / `INTERNAL_QUEUES` у сторожі; bull-board — `QUEUE_NAMES`):

| Черга                    | Що зовні                                                    |
| ------------------------ | ----------------------------------------------------------- |
| `checkbox`               | ПРРО (Checkbox / Вчасно.Каса)                               |
| `sms`                    | SMS / Viber / Email провайдери                              |
| `outbound-webhook`       | HTTP-endpoint клієнта                                       |
| `payment-polling`        | платіжний шлюз (monobank / LiqPay)                          |
| `nova-poshta-polling`    | служба доставки                                             |
| `nbu-fetch`              | курси НБУ                                                   |
| `bank-statement-polling` | API банку                                                   |
| `supplier-search`        | API постачальників: перевірка підключення, пошук пропозицій |
| `supplier-order`         | API постачальників: відправка замовлення, статуси           |
| `supplier-catalog`       | API постачальника: дзеркало каталогу (AVD)                  |

Внутрішні (лише БД і Redis): `loyalty`, `followup`, `invoice-overdue`, `reconciliation`,
`idempotency-purge`, `integration-log-purge`, `dead-letter-purge`, `supplier-maintenance`.

**Ліміт постачальника (429 / `x-ratelimit-*` / `Retry-After`).** Задача не падає і не витрачає спробу:
обробник робить `job.moveToDelayed(<час скидання квоти>, token)` і кидає `DelayedError`. Квота
тримається в Redis на підключення (`SupplierRateLimiter`), тож наступні задачі тієї ж області
відкладаються без звернення до мережі (BR-SCON-007).

**Помилка, яку повтор не виправить** (невірні креди, 4xx, наша валідація) — `UnrecoverableError`, і
доменний рядок одразу FAILED із причиною. Решта — повтор за backoff; FAILED — лише на останній спробі.

**Рядок у БД — джерело правди, `job.data` — лише id.** UI опитує наш ендпоінт, а не чергу. Redis
недоступний — рядок лишається QUEUED / PENDING, його переставляє повторювана задача `sweep`
(`supplier-maintenance`); тому постановка в чергу після коміту — `.catch()`, а не `await` без захисту.

**Неповторюваний виклик (оформлення замовлення) і неоднозначна відмова** (тайм-аут, обрив, 5xx) — не
повтор, а звірка за нашим `reference` (крок `RECONCILE`); не знайдено — `UNKNOWN`, людина перевіряє в
кабінеті постачальника. Повторне оформлення без перевірки дало б постачальнику друге замовлення
(BR-SCON-011).
