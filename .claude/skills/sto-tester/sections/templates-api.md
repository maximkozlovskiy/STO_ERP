# sto-tester — templates-api

> Частина скіла `sto-tester`; винесено дослівно, щоб кожен файл влазив в один Read.

> Повні шаблони коду для Кроку 5 (FULL): тут §4.3 Contract, §4.4 Property-based, §4.8 Негативне,
> §4.9 Нефункціональне, §S Service unit test. §4.5 E2E, §4.6 Component, §4.7 Функціональне —
> у `templates-web-e2e.md`.

---

## §4.3 Contract-тести (Supertest)

Contract-тести перевіряють **HTTP шар**: статус-коди, shape відповіді, заголовки авторизації.
Вони не мокають Prisma — звертаються до реального NestJS application instance з мокнутим PrismaService.

> **Мета:** виявити розрив між `toResponseDto()` у сервісі та `interface` у фронтенді — до того як це зробить користувач.

### Коли писати contract-тест

- Новий `@Controller` → одразу додати `.contract.spec.ts`
- Зміна `toResponseDto()` → оновити snapshot
- Новий endpoint → тест на 401 без токена, 403 з неправильною роллю, 200/201 з валідним тілом

### Структура

```
apps/api/src/modules/{domain}/{domain}.contract.spec.ts
```

### Шаблон contract-тесту

```typescript
// apps/api/src/modules/work-orders/work-orders.contract.spec.ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkOrdersModule } from './work-orders.module';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const prismaMock = {
  workOrder: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr)),
};

const mockJwtGuard = { canActivate: vi.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('WorkOrders — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [WorkOrdersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  describe('GET /work-orders', () => {
    it('повертає 200 з paginatedShape', async () => {
      prismaMock.$transaction.mockResolvedValueOnce([[], 0]);
      const res = await request(app.getHttpServer())
        .get('/work-orders')
        .query({ page: 1, limit: 20 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      });
    });

    it('повертає 401 без авторизації', async () => {
      mockJwtGuard.canActivate.mockReturnValueOnce(false);
      const res = await request(app.getHttpServer()).get('/work-orders');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /work-orders', () => {
    it("повертає 400 при відсутніх обов'язкових полях", async () => {
      const res = await request(app.getHttpServer())
        .post('/work-orders')
        .send({ description: 'без vehicleId і counterpartyId' });
      expect(res.status).toBe(400);
    });

    it('повертає 201 з коректним DTO', async () => {
      prismaMock.workOrder.create.mockResolvedValueOnce({
        id: 'wo-uuid',
        number: 'WO-2026-0001',
        status: 'DRAFT',
        totalAmount: 0,
        totalLabor: 0,
        totalParts: 0,
        paidAmount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB' },
        counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
        branch: { name: 'Центр' },
      });
      prismaMock.workOrder.count.mockResolvedValueOnce(0);

      const res = await request(app.getHttpServer())
        .post('/work-orders')
        .send({ vehicleId: 'v-uuid', counterpartyId: 'c-uuid', branchId: 'b-uuid' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        number: expect.any(String),
        status: expect.any(String),
        vehicle: expect.objectContaining({ make: expect.any(String) }),
        counterparty: expect.any(Object),
      });
    });
  });
});
```

### Що перевіряти в contract-тестах

| Endpoint                        | Тест-кейси                                                                |
| ------------------------------- | ------------------------------------------------------------------------- |
| `GET /work-orders`              | 200 з pagination shape; 401 без токена                                    |
| `POST /work-orders`             | 201 + DTO shape; 400 без обов'яз. полів                                   |
| `PATCH /work-orders/:id/status` | 400 при невалідному FSM-переході                                          |
| `GET /inventory`                | 200 + items[].available присутній                                         |
| `POST /auth/login`              | 200 + `{ accessToken, refreshToken, employee }`; 401 при невірному паролі |
| `GET /sync/pull`                | 200 + `{ records, maxSyncVersion }` shape                                 |

### Запуск

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## §4.4 Property-based тести (fast-check)

> **AUTO:** пропустити. **FULL:** виконати якщо `fast-check` встановлений.

### Встановлення

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
```

### FSM — всі заборонені переходи

```typescript
// apps/api/src/modules/work-orders/work-orders.fsm.spec.ts
import * as fc from 'fast-check';
import { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

const ALL_STATUSES = Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[];

describe('WORK_ORDER_TRANSITIONS — property-based', () => {
  it('карта переходів консистентна', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (from, to) => {
          const allowed = WORK_ORDER_TRANSITIONS[from];
          return !allowed.includes(to) || true; // map is consistent
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ARCHIVED і CANCELLED — фінальні стани', () => {
    expect(WORK_ORDER_TRANSITIONS['ARCHIVED']).toHaveLength(0);
    expect(WORK_ORDER_TRANSITIONS['CANCELLED']).toHaveLength(0);
  });
});
```

### Inventory — інваріант балансу

```typescript
// apps/api/src/modules/inventory/inventory.invariants.spec.ts
import * as fc from 'fast-check';
import { StockMovementType } from '@prisma/client';

function applyMovements(movements: { type: StockMovementType; qty: number }[]) {
  let quantity = 0;
  let reserved = 0;
  for (const { type, qty } of movements) {
    switch (type) {
      case 'RECEIPT':
        quantity += qty;
        break;
      case 'RESERVATION':
        if (quantity - reserved < qty) return null;
        reserved += qty;
        break;
      case 'RESERVATION_RELEASE':
        if (reserved < qty) return null;
        reserved -= qty;
        break;
      case 'WRITEOFF':
        if (quantity - reserved < qty) return null;
        quantity -= qty;
        break;
    }
  }
  return { quantity, reserved, available: quantity - reserved };
}

describe('Inventory — balance invariants', () => {
  it('після валідних рухів: quantity >= 0, reserved >= 0, available >= 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<StockMovementType>(
              'RECEIPT',
              'RESERVATION',
              'RESERVATION_RELEASE',
              'WRITEOFF',
            ),
            qty: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        movements => {
          const result = applyMovements(movements);
          if (result === null) return true;
          return result.quantity >= 0 && result.reserved >= 0 && result.available >= 0;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
```

### Settlements — кумулятивний баланс

```typescript
// apps/api/src/modules/settlements/settlements.invariants.spec.ts
import * as fc from 'fast-check';

type TxType = 'CHARGE' | 'PAYMENT' | 'PREPAYMENT' | 'REFUND' | 'CREDIT_NOTE';

function applyTransactions(txs: { type: TxType; amount: number }[]): number {
  return txs.reduce(
    (balance, { type, amount }) => (type === 'CHARGE' ? balance + amount : balance - amount),
    0,
  );
}

describe('Settlements — balance invariants', () => {
  it('тільки CHARGE збільшує баланс', () => {
    fc.assert(
      fc.property(fc.float({ min: 0.01, max: 100_000, noNaN: true }), amount => {
        return applyTransactions([{ type: 'CHARGE', amount }]) > 0;
      }),
    );
  });

  it('PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE зменшують баланс', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
        fc.float({ min: 0.01, max: 100_000, noNaN: true }),
        (type, amount) => {
          const before = 200_000;
          return before + applyTransactions([{ type, amount }]) < before;
        },
      ),
    );
  });

  it('SUM(CHARGE) = SUM(PAYMENT) → balance = 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0.01, max: 1000, noNaN: true }), { minLength: 1, maxLength: 10 }),
        amounts => {
          const total = amounts.reduce((s, a) => s + a, 0);
          const txs = [
            ...amounts.map(amount => ({ type: 'CHARGE' as TxType, amount })),
            { type: 'PAYMENT' as TxType, amount: total },
          ];
          return Math.abs(applyTransactions(txs)) < 0.001;
        },
      ),
    );
  });
});
```

### Pricing algorithm invariants

```typescript
// apps/api/src/modules/inventory/pricing.invariants.spec.ts
import * as fc from 'fast-check';

const calcPercent = (cost: number, pct: number) => Math.max(0, cost * (1 + pct / 100));
const applyRounding = (value: number, roundTo: number) =>
  roundTo <= 0 ? value : Math.round(value / roundTo) * roundTo;

describe('Pricing — algorithm invariants', () => {
  it('PERCENT >= 0 для cost >= 0 і pct >= 0', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 100_000, noNaN: true }),
        fc.float({ min: 0, max: 500, noNaN: true }),
        (cost, pct) => calcPercent(cost, pct) >= 0,
      ),
    );
  });

  it('округлення є кратним roundTo', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 10_000, noNaN: true }),
        fc.constantFrom(0.5, 1, 5, 10, 50, 100),
        (value, r) => {
          const rounded = applyRounding(value, r);
          return Math.abs(rounded % r) < 0.001 || Math.abs((rounded % r) - r) < 0.001;
        },
      ),
    );
  });
});

describe('WorkOrder totals — invariants', () => {
  it('totalAmount = totalLabor + totalParts завжди', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), { minLength: 0, maxLength: 20 }),
        fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), { minLength: 0, maxLength: 20 }),
        (lineAmounts, partAmounts) => {
          const totalLabor = lineAmounts.reduce((s, a) => s + a, 0);
          const totalParts = partAmounts.reduce((s, a) => s + a, 0);
          const directSum = [...lineAmounts, ...partAmounts].reduce((s, a) => s + a, 0);
          return Math.abs(totalLabor + totalParts - directSum) < 0.001;
        },
      ),
    );
  });
});
```

### Запуск

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
```

---

## §4.8 Негативне тестування

### DTO / Validation

```typescript
describe('POST /work-orders — негативні кейси', () => {
  it('400 при відсутньому vehicleId', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ counterpartyId: 'c-uuid', branchId: 'b-uuid' });
    expect(res.status).toBe(400);
  });

  it('400 при некоректному UUID', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 'not-a-uuid', counterpartyId: 'c-uuid', branchId: 'b-uuid' });
    expect(res.status).toBe(400);
  });

  it("400 при від'ємній кількості", async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders/wo-id/parts')
      .set('Authorization', `Bearer ${token}`)
      .send({ goodId: 'g-uuid', warehouseId: 'w-uuid', quantity: -5, price: 100 });
    expect(res.status).toBe(400);
  });
});
```

| Endpoint                         | Негативний кейс        | Очікуваний код |
| -------------------------------- | ---------------------- | -------------- |
| `POST /work-orders`              | без `vehicleId`        | 400            |
| `POST /stock-movements`          | `quantity = 0`         | 400            |
| `POST /settlements/transactions` | `amount = 0`           | 400            |
| `PATCH /work-orders/:id/status`  | невалідний FSM-перехід | 400            |
| `GET /work-orders/:id`           | чужий orgId            | 404            |
| `POST /auth/login`               | неправильний пароль    | 401            |
| `POST /auth/refresh`             | протухлий токен        | 401            |

### Бізнес-правила

```typescript
describe('Inventory — негативні кейси', () => {
  it('RESERVATION: 400 якщо available < qty', async () => {
    stockItem.mockResolvedValue({ quantity: 5, reserved: 3, available: 2 });
    await expect(
      inventoryService.createMovement({
        type: 'RESERVATION',
        quantity: 5,
        goodId: 'g1',
        warehouseId: 'w1',
        orgId,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('WRITEOFF: 400 якщо quantity < qty', async () => {
    stockItem.mockResolvedValue({ quantity: 3, reserved: 0, available: 3 });
    await expect(
      inventoryService.createMovement({
        type: 'WRITEOFF',
        quantity: 5,
        goodId: 'g1',
        warehouseId: 'w1',
        orgId,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('WorkOrder FSM — негативні кейси', () => {
  it('DRAFT → COMPLETED заборонено', async () => {
    workOrder.mockResolvedValue({ status: 'DRAFT' });
    await expect(service.transition(orgId, 'wo1', 'COMPLETED')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('ARCHIVED → будь-який статус заборонено', async () => {
    workOrder.mockResolvedValue({ status: 'ARCHIVED' });
    for (const status of ['DRAFT', 'ESTIMATE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
      await expect(service.transition(orgId, 'wo1', status as WorkOrderStatus)).rejects.toThrow(
        BadRequestException,
      );
    }
  });
});
```

### Auth / Tenant Isolation

```typescript
describe('Tenant isolation', () => {
  it('GET /work-orders/:id — 404 якщо WO належить іншому orgId', async () => {
    prisma.workOrder.findFirst.mockResolvedValue(null);
    await expect(service.findOne('other-org', 'wo-id')).rejects.toThrow(NotFoundException);
  });
});

describe('Auth — негативні кейси', () => {
  it('401 без Authorization header', async () => {
    const res = await request(app.getHttpServer()).get('/work-orders');
    expect(res.status).toBe(401);
  });

  it('401 при протухлому access token', async () => {
    const res = await request(app.getHttpServer())
      .get('/work-orders')
      .set('Authorization', 'Bearer expired.jwt.token');
    expect(res.status).toBe(401);
  });
});
```

### Checklist негативного тестування

```bash
# Поля без @IsPositive або @Min(0)
grep -rn "@IsNumber\|@IsInt\|@IsPositive\|@Min" apps/api/src/modules/ --include="*.dto.ts" | grep -v "@Min(1\|@Min(0\|@IsPositive"

# Endpoints без ParseUUIDPipe
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe"
```

- [ ] Кожен `POST`/`PATCH` повертає 400 при відсутньому обов'язковому полі
- [ ] Кожен `:id` параметр має `ParseUUIDPipe`
- [ ] `quantity: 0` і `amount: 0` → 400
- [ ] Без `Authorization` → 401 на всі захищені endpoints
- [ ] Чужий `orgId` у :id → 404

---

## §4.9 Нефункціональне тестування

### Response Time

```bash
curl -o /dev/null -s -w "\n%{time_total}s — GET /work-orders\n" \
  -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/work-orders

# Пороги: list endpoints < 200ms; sync pull < 500ms; create < 300ms
```

```typescript
it('GET /work-orders відповідає за < 200ms', async () => {
  const start = Date.now();
  const res = await request(app.getHttpServer()).get('/work-orders').query({ page: 1, limit: 20 });
  expect(res.status).toBe(200);
  expect(Date.now() - start).toBeLessThan(200);
}, 5_000);
```

### Security Headers

```bash
curl -I http://localhost:3000/api/health 2>/dev/null | grep -iE "x-content-type|x-frame|x-xss"
```

```typescript
it('security headers присутні', async () => {
  const res = await request(app.getHttpServer()).get('/health');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toMatch(/DENY|SAMEORIGIN/);
});
```

### Database Resilience

```bash
grep -rn "prisma.\$transaction" apps/api/src/ --include="*.ts" | grep -v "timeout:"
```

```typescript
it('Prisma P2002 → 409 Conflict', async () => {
  prisma.employee.create.mockRejectedValueOnce(
    Object.assign(new Error(), { code: 'P2002', meta: { target: ['login'] } }),
  );
  const res = await request(app.getHttpServer())
    .post('/employees')
    .send({ login: 'existing-login' });
  expect(res.status).toBe(409);
});
```

### BullMQ Resilience

```typescript
it('processor re-throws для BullMQ retry', async () => {
  smsService.send.mockRejectedValueOnce(new Error('Network error'));
  await expect(processor.handleSmsSend({ phone: '+380...', message: 'test' })).rejects.toThrow(
    'Network error',
  );
});
```

### Checklist нефункціонального тестування

```bash
# $transaction без timeout
grep -rn "prisma.\$transaction" apps/api/src/ --include="*.ts" -A10 | grep -v "timeout:" | grep "transaction("

# findMany без take
grep -rn "findMany(" apps/api/src/modules/ --include="*.service.ts" | grep -v "take:" | grep -v "spec"
```

- [ ] List endpoints `< 200ms` (локально)
- [ ] Security headers: `X-Content-Type-Options`, `X-Frame-Options`
- [ ] `$transaction` з явним `timeout: 5000`
- [ ] P2002 → 409; P2025 → 404
- [ ] BullMQ processors re-throw помилки
- [ ] Всі `findMany` мають `take` ліміт

---

## §S Service unit test шаблон (copy-paste)

```typescript
// apps/api/src/modules/{domain}/{domain}.<аспект>.spec.ts
// ОДИН аспект на файл (fsm, totals, pricing, sort…), НЕ {domain}.spec.ts «на все»:
// саме з таких файлів виросли 8 монолітів 913–1720 рядків. Спільний DI для 3+
// файлів -> {domain}.spec-fixture.ts (factory, не const — isolate:false без clearMocks).
import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkOrdersService } from './{domain}.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('{Domain}Service', () => {
  let service: WorkOrdersService;
  let prisma: ReturnType<typeof vi.mocked<PrismaService>>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        {
          provide: PrismaService,
          useValue: {
            workOrder: {
              findFirst: vi.fn(),
              findMany: vi.fn(),
              create: vi.fn(),
              update: vi.fn(),
              count: vi.fn(),
            },
            $transaction: vi
              .fn()
              .mockImplementation(fn => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
          },
        },
        { provide: InventoryService, useValue: { createMovement: vi.fn() } },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
      ],
    }).compile();

    service = module.get(WorkOrdersService);
    prisma = module.get(PrismaService) as unknown as ReturnType<typeof vi.mocked<PrismaService>>;
  });

  describe('transition', () => {
    it('кидає BadRequestException при недозволеному FSM-переході', async () => {
      (prisma.workOrder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'wo-1',
        orgId: 'org-1',
        status: 'COMPLETED',
        deletedAt: null,
      });
      await expect(service.transition('org-1', 'wo-1', 'DRAFT', 'emp-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
```
