# sto-dev — api

> Частина скіла `sto-dev`; винесено дослівно, щоб кожен файл влазив в один Read.

## NestJS / API

### Структура модуля

```
apps/api/src/modules/{domain}/
  {domain}.module.ts      ← DI тільки
  {domain}.controller.ts  ← HTTP шар: routing, guards, DTOs, @OrgContext()
  {domain}.service.ts     ← бізнес логіка + Prisma
  {domain}.dto.ts         ← class-validator DTOs + ResponseDTOs
  {domain}.contract.spec.ts     ← HTTP-контракт: DTO, статуси, валідація
  {domain}.<аспект>.spec.ts     ← ОДИН аспект на файл (fsm, totals, pricing…)
  {domain}.spec-fixture.ts      ← (optional) спільний DI/harness для 3+ файлів
```

**`{domain}.spec.ts` «на все» не створюємо** — саме з таких файлів виросли 8 монолітів
на 913–1720 рядків. Деталі моделі й гейти — `/sto-spec`.

### Fastify route ordering — специфічні роути ПЕРЕД параметричними

У Fastify (на відміну від Express) роути матчаться в порядку оголошення; `:id` — жадібний, захоплює `uuid/toggle-active` якщо оголошений першим. Завжди: `GET/PATCH :id/action` вище за `GET/PATCH :id`.

```typescript
// ❌ :id матчить "toggle-active" як параметр → Cannot PATCH /resource/:id/toggle-active
@Patch(':id')          update(...)    // захоплює "uuid/toggle-active" цілком
@Patch(':id/toggle-active')  toggle(...)

// ✅ Специфічний суброут ПЕРЕД загальним :id
@Patch(':id/toggle-active')  toggle(...)   // ← ПЕРШИЙ
@Get(':id/linked-something')  getLinks(...)  // ← ПЕРШИЙ
@Get(':id')           findOne(...)    // ← після всіх sub-routes
@Patch(':id')         update(...)     // ← після всіх sub-routes
@Delete(':id')        remove(...)     // ← після всіх sub-routes
```

### Controller — тільки HTTP шар

```typescript
// ❌ Бізнес-логіка в контролері
@Post()
async create(@Body() dto: CreateWorkOrderDto) {
  const count = await this.prisma.workOrder.count();  // ← БД у контролері!
  if (count > 1000) throw new BadRequestException('...');
  return this.service.create(dto);
}

// ✅ Контролер тонкий
@Post()
@Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
create(@OrgContext() orgId: string, @Body() dto: CreateWorkOrderDto) {
  return this.service.create(orgId, dto);
}
```

### Service — обов'язкові правила

```typescript
// 1. ЗАВЖДИ scope by orgId
// ❌
const wo = await this.prisma.workOrder.findUnique({ where: { id } });
// ✅
const wo = await this.prisma.workOrder.findFirst({
  where: { id, orgId, deletedAt: null },
});
if (!wo) throw new NotFoundException('Наряд не знайдено');

// 2. НІКОЛИ не видаляти — soft delete
// ❌
await this.prisma.workOrder.delete({ where: { id } });
// ✅
await this.prisma.workOrder.update({
  where: { id },
  data: { deletedAt: new Date() },
});

// 3. Зміни складу — тільки через InventoryService
// ❌
await this.prisma.stockItem.update({ where: { id }, data: { quantity: { decrement: qty } } });
// ✅
await this.inventoryService.createMovement(orgId, { type: 'WRITEOFF', goodId, warehouseId, quantity: -qty, ... });

// 4. Зміни балансу — тільки через SettlementsService
// ❌
await this.prisma.settlementAccount.update({ where: { id }, data: { balance: { decrement: amount } } });
// ✅
await this.settlementsService.createTransaction(orgId, { counterpartyId, type: 'CHARGE', amount, documentType: 'WorkOrder', documentId: wo.id });

// 4b. Мультивалюта — amountBase у базовій валюті org ТІЛЬКИ через ExchangeRatesService.resolveBaseConversion
//     Грошовий агрегат у не-базовій валюті (CashOperation, Payment, ...) пише пару (amountBase, rateUsed).
//     Джерело курсу — єдина точка resolveBaseConversion(orgId, currencyId, date, amount):
//       • валюта == base (OrganisationSettings.currency за КОДОМ) → { rateUsed: 1, amountBase: amount } (БЕЗ читання курсу)
//       • інакше getRateAsOf (найближчий курс date ≤ операції, НЕ майбутній) → convertToBase(amount, rate, coefficient)
//       • курсу на дату немає → 400 (НІКОЛИ тихо rate=1 — спотворить base-облік)
//     convertToBase = roundMoney(amount * rate / safeCoeff(coefficient)); rate НБУ = base за (1×coefficient) од.
// ❌ amountBase = amount (без конвертації) для валютної операції       // спотворює звітність у базовій
// ❌ курсу немає → fallback rate=1                                     // тихе спотворення base
// ✅ const conv = await this.exchangeRates.resolveBaseConversion(orgId, register.currencyId, new Date(), amount);
//    await tx.cashOperation.create({ data: { ...amount, amountBase: conv.amountBase, rateUsed: conv.rateUsed } });
//    // Баланс/overdraft каси — у ВАЛЮТІ каси (amount), НЕ base: каса моно-валютна, валюти не змішуємо.
//    // Помилки про суми каси — БЕЗ хардкоду ₴ (каса може бути USD/EUR); символ ₴ лише де base гарантовано UAH.

// 5. FSM — тільки через transition map
// ❌
await this.prisma.workOrder.update({ where: { id }, data: { status: newStatus } });
// ✅
const allowed = WORK_ORDER_TRANSITIONS[wo.status];
if (!allowed.includes(newStatus)) throw new BadRequestException(`Неможливо перевести з ${wo.status} у ${newStatus}`);

// 6. Кілька таблиць — транзакція
await this.prisma.$transaction(async (tx) => {
  await tx.workOrder.update(...);
  await tx.stockMovement.create(...);
  await tx.settlementTransaction.create(...);
});

// 7. Помилки — українською
throw new NotFoundException('Наряд не знайдено');
throw new BadRequestException('Недостатньо запчастин на складі');
throw new ConflictException('Підйомник вже зайнятий');

// 8. Exactly-once ЗОВНІШНІЙ ефект (Z-звіт, чек, SMS) — CAS-claim ПЕРЕД викликом (Bug #711)
// ❌ stale head-check → external → update: 2 concurrent = 2 Z-звіти/чеки/SMS
const s = await prisma.cashShift.findFirst({ where: { id, orgId } });
if (s.status !== 'OPEN') throw new BadRequestException('Зміна вже закрита');
await provider.closeShift(cfg, token);              // ← обидва потоки сюди
await prisma.cashShift.update({ where: { id }, data: { status: 'CLOSED' } });
// ✅ CAS-claim статусу ПЕРШИМ; count===0 → програвший не робить другий ефект
const claim = await prisma.cashShift.updateMany({
  where: { id, orgId, status: 'OPEN', deletedAt: null },
  data: { status: 'CLOSED', closedAt: new Date() },
});
if (claim.count === 0) throw new BadRequestException('Зміна вже закрита');
try { await provider.closeShift(cfg, token); }      // рівно 1 переможець
catch (e) { await prisma.cashShift.updateMany({ where: { id, orgId, status: 'CLOSED', zReportId: null }, data: { status: 'OPEN', closedAt: null } }); throw e; }

// 9. CAS проти гонки ≠ перевірка бізнес-max (Bug #712) — потрібні ОБИДВА
// ❌ CAS захищає від подвоєння, але прийом 100 на замовлені 10 проходить чисто
await tx.purchaseOrderLine.updateMany({ where: { id, receivedQty: line.receivedQty }, data: { receivedQty: { increment: recv.qty } } });
// ✅ fail-fast стеля ПЕРЕД tx (Float → EPSILON проти IEEE-754-дрейфу), потім CAS
if (line.receivedQty + recv.qty > line.quantity + 1e-6) throw new BadRequestException('Кількість прийому перевищує залишок');
```

### DTO — обов'язкові декоратори

```typescript
export class CreateWorkOrderDto {
  @ApiProperty({ description: 'ID автомобіля', example: 'uuid' })
  @IsUUID()
  vehicleId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // ✅ Enum-поле → @IsEnum(TheEnum), НІКОЛИ @IsString.
  // @IsString пропускає будь-який рядок → долітає до Prisma enum-колонки → Postgres
  // "invalid input value for enum" → HTTP 500 (не-i18n) замість чистого 400.
  @ApiPropertyOptional({ enum: WorkOrderStatus })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;
}

export class WorkOrderResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: WorkOrderStatus }) status: WorkOrderStatus;
  // ⚠️ Ніколи не повертай raw Prisma model — маппи через toResponseDto()
}
```

### Запобігання N+1

```typescript
// ❌ N+1
const orders = await this.prisma.workOrder.findMany({ where: { orgId } });
for (const o of orders) {
  const v = await this.prisma.vehicle.findUnique({ where: { id: o.vehicleId } });
}

// ✅ include / select
const orders = await this.prisma.workOrder.findMany({
  where: { orgId, deletedAt: null },
  include: {
    vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
    counterparty: { select: { id: true, firstName: true, lastName: true, phone: true } },
  },
});
```

---

## Prisma 5

### Обов'язкові поля кожної моделі

```prisma
model AnyModel {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime? // soft delete — ніколи не видаляти hard
  syncVersion BigInt    @default(0)

  @@index([orgId, deletedAt])
  @@index([orgId, syncVersion])  // для delta-sync
}
```

### Зміна schema.prisma ЗАВЖДИ потребує міграції

Правка `schema.prisma` оновлює лише типи Prisma client — НЕ базу. TS компілюється, але runtime fail при insert/select нового значення. **Кожна зміна → нова папка у `migrations/`.**

```sql
-- ❌ Додати enum value тільки у schema.prisma (PIT/RAMP) → insert type='PIT' впаде в runtime
-- ✅ Окремий файл migrations/YYYYMMDDHHMMSS_add_lift_type_pit_ramp/migration.sql:
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'PIT';
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'RAMP';
-- ADD VALUE — окремий файл (Postgres забороняє ADD VALUE + використання у одній транзакції)
```

### Заборонені операції

Hard delete, пряме оновлення `StockItem`/`SettlementAccount`, запит без `orgId` — див. §2 Service (правила 1-4). Специфічне для Prisma:

```typescript
// ❌ findMany без take (необмежена вибірка)
prisma.stockMovement.findMany({ where: { orgId } }); // може повернути мільйони рядків
// ✅
prisma.stockMovement.findMany({ where: { orgId }, take: limit, skip: offset });
```

---

## SSE (Server-Sent Events) — Real-time дані без WebSocket

```typescript
// ❌ Polling (зайве навантаження)
useEffect(() => {
  const id = setInterval(() => apiFetch('/dashboard/summary').then(setData), 30_000);
  return () => clearInterval(id);
}, []);

// ✅ SSE з reconnect + AbortController cleanup
useEffect(() => {
  const es = new EventSource('/api/dashboard/stream', {
    // withCredentials потрібен якщо auth через cookie
  });
  es.onmessage = (e) => setData(JSON.parse(e.data));
  es.onerror = () => { es.close(); }; // браузер авто-реконектиться за spec
  return () => es.close();
}, []);

// Backend (NestJS + Fastify) — SSE endpoint:
// ❌ НЕ використовувати @Sse() декоратор NestJS з Fastify — несумісно
// ✅ Реалізувати через Fastify reply напряму:
@Get('stream')
async stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(async () => {
    const kpi = await this.dashboardService.getKpi(orgId);
    send(kpi);
  }, 30_000);

  req.raw.on('close', () => clearInterval(interval));
}
```

**Правила SSE:**

- Endpoint захищений JWT (НЕ `@Public()`) — token у query param або Authorization header
- Завжди `req.raw.on('close', cleanup)` — прибирати interval/subscription при відключенні клієнта
- Fallback у frontend: `if (!window.EventSource) { /* polling fallback */ }`
- SSE — тільки server→client; для client→server — окремий REST endpoint

---

## Polymorphic entities — Comments, AuditLog, Media

```typescript
// Polymorphic relation через entityType + entityId (без FK):
model Comment {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String   @db.Uuid
  entityType  String   // 'WorkOrder' | 'Counterparty' | 'Vehicle'
  entityId    String   @db.Uuid
  body        String
  authorId    String   @db.Uuid
  createdAt   DateTime @default(now())
  // НЕМАє deletedAt, updatedAt, syncVersion — append-only

  @@index([orgId, entityType, entityId, createdAt])
}

// ❌ НЕ використовувати nullable FK для polymorphism:
// workOrderId String? + counterpartyId String? — кожен новий тип = нова міграція

// ✅ entityType + entityId + @@index
// При запиті: WHERE "orgId" = $orgId AND "entityType" = 'WorkOrder' AND "entityId" = $id
```

**Правила polymorphic:**

- Завжди composite index `[orgId, entityType, entityId, createdAt]` — без нього повний scan
- `entityType` — константи в `@sto/shared/constants` (не magic strings у сервісах)
- Tenant isolation: завжди фільтрувати по `orgId` (entityId може випадково збігтись між org-ами)
- Append-only сутності (`Comment`, `AuditEvent`, `WorkOrderMedia`) — без `deletedAt`; hard limit по кількості (take: 100)

---

## Webhook pattern — вихідні нотифікації

```typescript
// Не блокувати основну транзакцію — webhook через BullMQ:
// ❌
await this.webhookService.deliver('WO_STATUS_CHANGED', payload); // може timeout 5s

// ✅
await this.webhookQueue.add(
  'deliver',
  { event: 'WO_STATUS_CHANGED', orgId, payload },
  {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60_000 },
  },
);

// Processor — HMAC-підпис для безпеки:
const signature = crypto
  .createHmac('sha256', endpoint.secret)
  .update(JSON.stringify(payload))
  .digest('hex');

await fetch(endpoint.url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-STO-Signature': `sha256=${signature}`,
    'X-STO-Event': event,
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10_000), // обов'язковий timeout
});
```

**Правила Webhook:**

- HMAC-підпис (`X-STO-Signature`) — клієнт верифікує через той самий secret
- `AbortSignal.timeout(10_000)` — без цього зависаємо на повільному клієнті
- Зберігати `WebhookDelivery` з response code і body (max 1KB) — для debug UI
- Max 5 спроб (менше ніж SMS/ПРРО) — webhook не фінансово-критичний
- `endpoint.isActive = false` якщо 5 поспіль провалів — авто-деактивація щоб не спамити

---

## Offline-first / BullMQ

```typescript
// ❌ Прямий виклик зовнішнього API
await this.smsService.send(phone, message); // впаде без інтернету

// ✅ Через BullMQ чергу — retry при відновленні
await this.smsQueue.add(
  'send',
  { phone, message },
  {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 },
  },
);
```

Зовнішні API що завжди через чергу: **TurboSMS**, **Checkbox (ПРРО)**, **постачальники прайсів**, **Cloud Sync**.

---
