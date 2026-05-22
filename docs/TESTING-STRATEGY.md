# STO ERP — Стратегія тестування

> Що тестуємо, як тестуємо, скільки тестуємо. Claude Code читає цей файл при написанні тестів.

---

## Тестова піраміда

```
          ╔══════════════╗
          ║   E2E (5%)   ║   Playwright — критичні user journeys
          ╠══════════════╣
          ║Integration(25%)║  Supertest — HTTP endpoints + реальна БД
          ╠══════════════╣
          ║  Unit (70%)  ║   Vitest — service методи, FSM, бізнес-логіка
          ╚══════════════╝

Ціль: >80% coverage на service рівні
```

---

## 1. Unit тести (Vitest)

### Що тестуємо

- **Service методи** — бізнес-логіка, розрахунки, валідації
- **FSM переходи** — всі дозволені та заборонені переходи
- **Бізнес-правила** — кожне правило з CLAUDE.md
- **Утиліти** — `formatCurrency`, `formatDate`, схеми Zod

### Що НЕ тестуємо на unit рівні

- Контролери (тестуємо через інтеграційні тести)
- Prisma запити напряму (мокуємо PrismaService)
- Зовнішні API (BullMQ jobs — мокуємо queue)

### Налаштування (vitest.config.ts)

```typescript
// apps/api/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/modules/**/*.service.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
```

### Шаблон unit тесту (Service)

```typescript
// apps/api/src/modules/work-orders/work-orders.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { WorkOrdersService } from './work-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// Фабрика моків — в окремому файлі або в describe
const mockWorkOrder = (overrides = {}) => ({
  id: 'wo-uuid-1',
  orgId: 'org-uuid-1',
  status: 'DRAFT',
  vehicleId: 'vehicle-uuid-1',
  counterpartyId: 'counterparty-uuid-1',
  totalAmount: '0',
  deletedAt: null,
  ...overrides,
});

describe('WorkOrdersService', () => {
  let service: WorkOrdersService;
  let prisma: { workOrder: Record<string, ReturnType<typeof vi.fn>> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      workOrder: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
    };
    eventEmitter = { emit: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(WorkOrdersService);
  });

  // ─── FSM переходи ───────────────────────────────────────
  describe('transition()', () => {
    it('дозволяє перехід DRAFT → ESTIMATE', async () => {
      const wo = mockWorkOrder({ status: 'DRAFT' });
      prisma.workOrder.findFirst.mockResolvedValue(wo);
      prisma.workOrder.update.mockResolvedValue({ ...wo, status: 'ESTIMATE' });

      const result = await service.transition('wo-uuid-1', 'ESTIMATE', 'user-1', 'org-uuid-1');

      expect(result.status).toBe('ESTIMATE');
      expect(prisma.workOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ESTIMATE' }) })
      );
    });

    it('кидає BadRequestException при забороненому переході', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(mockWorkOrder({ status: 'DRAFT' }));

      await expect(
        service.transition('wo-uuid-1', 'PAID', 'user-1', 'org-uuid-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('кидає NotFoundException якщо наряд не знайдено', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.transition('non-existent', 'ESTIMATE', 'user-1', 'org-uuid-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('емітить подію після успішного переходу', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(mockWorkOrder({ status: 'DRAFT' }));
      prisma.workOrder.update.mockResolvedValue(mockWorkOrder({ status: 'ESTIMATE' }));

      await service.transition('wo-uuid-1', 'ESTIMATE', 'user-1', 'org-uuid-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith('work-order.estimate', expect.any(Object));
    });
  });

  // ─── Бізнес-правила ─────────────────────────────────────
  describe('orgId ізоляція', () => {
    it('не знаходить наряд з чужого orgId', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null); // повертає null для чужого org

      await expect(
        service.transition('wo-uuid-1', 'ESTIMATE', 'user-1', 'other-org-id')
      ).rejects.toThrow(NotFoundException);

      expect(prisma.workOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orgId: 'other-org-id' }) })
      );
    });
  });
});
```

### Тестування Zod схем

```typescript
// packages/shared/src/schemas/work-order.schema.spec.ts
import { describe, it, expect } from 'vitest';
import { createWorkOrderSchema } from './work-order.schema';

describe('createWorkOrderSchema', () => {
  it('валідує коректні дані', () => {
    const result = createWorkOrderSchema.safeParse({
      vehicleId: '550e8400-e29b-41d4-a716-446655440000',
      counterpartyId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(true);
  });

  it('відхиляє невалідний UUID', () => {
    const result = createWorkOrderSchema.safeParse({ vehicleId: 'not-a-uuid' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('UUID');
  });
});
```

---

## 2. Інтеграційні тести (Supertest)

### Що тестуємо

- HTTP endpoints — статус коди, тіла відповідей
- Auth flow — login, refresh, logout
- Критичні бізнес-сценарії end-to-end (зі справжньою тестовою БД)
- Middleware — guards, pipes, interceptors

### Налаштування тестової БД

```typescript
// apps/api/src/test/setup.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL } },
});

beforeAll(async () => {
  // Запустити міграції на тестовій БД
  await prisma.$executeRaw`TRUNCATE TABLE "work_orders" CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});
```

```bash
# .env.test
TEST_DATABASE_URL=postgresql://sto:sto@localhost:5432/sto_erp_test
```

### Шаблон інтеграційного тесту

```typescript
// apps/api/src/modules/work-orders/work-orders.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, seedTestOrg, getAuthToken } from '../test/helpers';

describe('WorkOrders (integration)', () => {
  let app: INestApplication;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const { org, employee } = await seedTestOrg();
    orgId = org.id;
    token = await getAuthToken(app, employee);
  });

  afterAll(() => app.close());

  describe('POST /api/work-orders', () => {
    it('201 — створює наряд з валідними даними', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/work-orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ vehicleId: '...', counterpartyId: '...' })
        .expect(201);

      expect(res.body.status).toBe('DRAFT');
      expect(res.body.orgId).toBe(orgId);
    });

    it('401 — без токена', async () => {
      await request(app.getHttpServer())
        .post('/api/work-orders')
        .send({})
        .expect(401);
    });

    it('422 — без обов\'язкових полів', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/work-orders')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(422);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toBeInstanceOf(Array);
    });
  });

  describe('POST /api/work-orders/:id/transition', () => {
    it('повний lifecycle: DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → COMPLETED', async () => {
      // Створюємо наряд
      const { body: wo } = await request(app.getHttpServer())
        .post('/api/work-orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ vehicleId: '...', counterpartyId: '...' })
        .expect(201);

      // DRAFT → ESTIMATE
      await request(app.getHttpServer())
        .post(`/api/work-orders/${wo.id}/transition`)
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'ESTIMATE' })
        .expect(200);

      // ... далі по ланцюжку
    });
  });
});
```

---

## 3. E2E тести (Playwright)

### Що тестуємо — тільки критичні user journeys

| Journey | Пріоритет |
|---------|-----------|
| Створення наряду → завершення → виставлення рахунку → оплата | P0 |
| Прийом товару → списання на наряд | P0 |
| Розрахунок з клієнтом → фіскальний чек | P0 |
| Авторизація (login / logout / refresh) | P0 |
| Реєстрація нового клієнта + авто | P1 |
| Інвентаризація складу | P1 |

### Налаштування Playwright

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3001',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3001',
    reuseExistingServer: true,
  },
});
```

---

## 4. Тестування мобільного додатку

### Unit тести — React Native Testing Library

```typescript
// apps/mobile/src/features/work-orders/ui/__tests__/WorkOrderCard.test.tsx
import { render, screen } from '@testing-library/react-native';
import { WorkOrderCard } from '../WorkOrderCard';

it('відображає номер та статус наряду', () => {
  render(
    <WorkOrderCard
      workOrder={{ number: 'WO-2024-0001', status: 'IN_PROGRESS', totalAmount: '1250.00' }}
    />
  );

  expect(screen.getByText('WO-2024-0001')).toBeTruthy();
  expect(screen.getByText('В роботі')).toBeTruthy();   // Ukrainian label
  expect(screen.getByText('1 250,00 ₴')).toBeTruthy();
});
```

### Тестування WatermelonDB (офлайн)

```typescript
// Використовувати in-memory адаптер для тестів
import { Database } from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';

const testDatabase = new Database({
  adapter: new LokiJSAdapter({ schema, useWebWorker: false }),
  modelClasses: [WorkOrderModel],
});
```

---

## 5. Тестування специфічне для STO ERP

### Обов'язкові тести для кожного модуля

```
✅ FSM — всі дозволені переходи
✅ FSM — всі заборонені переходи (кожен кидає BadRequestException)
✅ orgId isolation — запит з чужим orgId повертає 404
✅ Soft delete — deletedAt встановлюється, запис не видаляється фізично
✅ Guard умови — перехід без виконання guard-умови кидає помилку
✅ Happy path — основний бізнес-сценарій
```

### Тести для Inventory

```typescript
it('не дозволяє списання більше ніж є на складі', async () => {
  // stockItem.quantity = 5
  await expect(
    inventoryService.createMovement({ type: 'WRITEOFF', quantity: -10, ... })
  ).rejects.toThrow('Недостатньо товару на складі');
});

it('createMovement оновлює StockItem.quantity атомарно', async () => {
  // Перевіряємо що використовується $transaction
  await inventoryService.createMovement({ type: 'RECEIPT', quantity: 10, ... });
  expect(prisma.$transaction).toHaveBeenCalled();
});
```

### Тести для Settlements

```typescript
it('createTransaction оновлює баланс SettlementAccount', async () => {
  const before = await getBalance(counterpartyId);
  await settlementsService.createTransaction({ type: 'CHARGE', amount: 1000, ... });
  const after = await getBalance(counterpartyId);
  expect(after - before).toBe(1000);
});
```

---

## 6. Запуск тестів

```bash
# Всі unit тести
pnpm test

# З покриттям
pnpm --filter @sto/api test:coverage

# Watch mode (розробка)
pnpm --filter @sto/api test:watch

# Конкретний файл
pnpm --filter @sto/api test work-orders.service.spec.ts

# Інтеграційні
pnpm --filter @sto/api test:e2e

# E2E (Playwright)
pnpm --filter @sto/web e2e

# Mobile
pnpm --filter @sto/mobile test
```

---

## 7. CI pipeline (тести)

```yaml
# .github/workflows/test.yml (або аналог для локального CI)
steps:
  - name: Unit tests
    run: pnpm test --coverage

  - name: Integration tests
    env:
      TEST_DATABASE_URL: postgresql://...
    run: pnpm --filter @sto/api test:e2e

  - name: Type check
    run: pnpm type-check

  - name: Lint
    run: pnpm lint
```

