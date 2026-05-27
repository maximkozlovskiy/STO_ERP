---
name: sto-backend
description: >
  Create a complete NestJS backend module for STO ERP: DTO, service, controller, Swagger docs, and unit tests. Use when the user says "зроби API", "endpoint", "бекенд", "контролер", "сервіс", "NestJS модуль", or when implementing the backend layer of a feature. Always run AFTER sto-database (schema must exist). Produces production-ready NestJS code following STO ERP conventions.
model: claude-sonnet-4-6
---

# sto-backend — NestJS Module Skill

## Before Starting

1. Read `packages/database/schema.prisma` — know the models
2. Read `sto-context` — understand domain rules
3. Read `sto-dev` — coding standards (TS, NestJS, Prisma patterns) — prevents sto-review findings
4. Check existing similar module for patterns

---

## Module Structure

```
apps/api/src/modules/{domain}/
  {domain}.module.ts
  {domain}.controller.ts
  {domain}.service.ts
  {domain}.dto.ts
  {domain}.events.ts       (optional)
  {domain}.spec.ts
```

---

## DTO Pattern

```typescript
// {domain}.dto.ts
import { IsUUID, IsString, IsOptional, IsEnum, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateWorkOrderDto {
  @ApiProperty()
  @IsUUID()
  vehicleId: string;

  @ApiProperty()
  @IsUUID()
  counterpartyId: string;

  @ApiProperty()
  @IsUUID()
  branchId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class WorkOrderResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() number: string;
  @ApiProperty({ enum: WorkOrderStatus }) status: WorkOrderStatus;
  @ApiProperty() totalAmount: number;
  @ApiProperty() vehicle: { id: string; make: string; model: string; licensePlate: string };
  @ApiProperty() counterparty: { id: string; firstName: string; lastName: string; phone: string };
  @ApiProperty() createdAt: Date;
  // Never expose raw Prisma model — only map needed fields
}

export class PaginatedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  limit: number = 20;
}
```

---

## Service Pattern

```typescript
// {domain}.service.ts
import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async create(orgId: string, dto: CreateWorkOrderDto): Promise<WorkOrderResponseDto> {
    // 1. Validate business rules BEFORE writing
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, orgId, deletedAt: null },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // 2. Generate human-readable number
    const count = await this.prisma.workOrder.count({ where: { orgId } });
    const number = `WO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    // 3. Write to DB in transaction
    const workOrder = await this.prisma.workOrder.create({
      data: { ...dto, orgId, number, status: 'DRAFT' },
      include: {
        vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
        counterparty: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
    });

    // 4. Emit domain event
    this.events.emit('work-order.created', { workOrderId: workOrder.id, orgId });

    return this.toResponseDto(workOrder);
  }

  async transition(orgId: string, id: string, newStatus: WorkOrderStatus, employeeId: string) {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!wo) throw new NotFoundException('Work order not found');

    // Validate FSM transition
    const allowed = WORK_ORDER_TRANSITIONS[wo.status];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Cannot transition from ${wo.status} to ${newStatus}`);
    }

    // Special logic per transition
    if (newStatus === 'IN_PROGRESS') {
      await this.reserveParts(orgId, id);
    }
    if (newStatus === 'COMPLETED') {
      await this.deductPartsAndSettle(orgId, id);
    }

    return this.prisma.workOrder.update({
      where: { id },
      data: { status: newStatus, ...(newStatus === 'COMPLETED' ? { completedAt: new Date() } : {}) },
    });
  }

  private async reserveParts(orgId: string, workOrderId: string) {
    // Creates RESERVATION StockMovements and updates StockItem.reserved
  }

  private async deductPartsAndSettle(orgId: string, workOrderId: string) {
    // In a single transaction:
    // 1. Create WRITEOFF StockMovements
    // 2. Update StockItem.quantity -= qty, .reserved -= qty
    // 3. Create SettlementTransaction(CHARGE) for counterparty
  }

  async findAll(orgId: string, page: number, limit: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where: { orgId, deletedAt: null },
        include: {
          vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
          counterparty: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.workOrder.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(this.toResponseDto), total, page, limit };
  }

  private toResponseDto(wo: any): WorkOrderResponseDto {
    return {
      id: wo.id,
      number: wo.number,
      status: wo.status,
      totalAmount: Number(wo.totalAmount),
      vehicle: wo.vehicle,
      counterparty: wo.counterparty,
      createdAt: wo.createdAt,
    };
  }
}

// FSM transition map
const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT:      ['ESTIMATE', 'CANCELLED'],
  ESTIMATE:   ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED:   ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS:['ON_HOLD', 'COMPLETED'],
  ON_HOLD:    ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED:  ['INVOICED'],
  INVOICED:   ['PAID'],
  PAID:       ['ARCHIVED'],
  ARCHIVED:   [],
  CANCELLED:  [],
};
```

---

## Controller Pattern

```typescript
// {domain}.controller.ts
import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { UserRole } from '@sto/shared';

@ApiTags('Work Orders')
@Controller('work-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WorkOrdersController {
  constructor(private readonly service: WorkOrdersService) {}

  @Post()
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Create new work order' })
  @ApiResponse({ status: 201, type: WorkOrderResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body() dto: CreateWorkOrderDto,
  ) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'List work orders with pagination' })
  findAll(
    @OrgContext() orgId: string,
    @Query() query: PaginatedQueryDto,
  ) {
    return this.service.findAll(orgId, query.page, query.limit);
  }

  @Patch(':id/status')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Transition work order status (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: TransitionWorkOrderDto,
  ) {
    return this.service.transition(orgId, id, dto.status, dto.employeeId);
  }
}
```

---

## Settlement Integration Rule

Any service method that changes financial state MUST call `SettlementsService`:

```typescript
// In WorkOrdersService constructor, inject SettlementsService
// When WO transitions to COMPLETED → CHARGE transaction
// When Payment is created → PAYMENT transaction
// When PO is received → CHARGE to supplier account
await this.settlementsService.createTransaction(orgId, {
  counterpartyId,
  type: 'CHARGE',
  amount: totalAmount,
  documentType: 'WorkOrder',
  documentId: workOrderId,
});
```

---

## Stock Mutation Rule

All stock changes go through `InventoryService.createMovement()` — never update `StockItem` directly:

```typescript
await this.inventoryService.createMovement(orgId, {
  goodId,
  warehouseId,
  type: 'WRITEOFF',
  quantity: -qty,  // negative = out
  documentType: 'WorkOrder',
  documentId: workOrderId,
});
// This method updates StockItem and writes StockMovement in a transaction
```

---

## Unit Test Pattern

```typescript
// {domain}.spec.ts
import { Test } from '@nestjs/testing';
import { WorkOrdersService } from './work-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('WorkOrdersService', () => {
  let service: WorkOrdersService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        {
          provide: PrismaService,
          useValue: {
            workOrder: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
            vehicle: { findFirst: jest.fn() },
            $transaction: jest.fn().mockImplementation((arr) => Promise.all(arr)),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(WorkOrdersService);
    prisma = module.get(PrismaService);
  });

  describe('create', () => {
    it('throws NotFoundException if vehicle not found', async () => {
      prisma.vehicle.findFirst.mockResolvedValue(null);
      await expect(service.create('org-1', { vehicleId: 'v-1', counterpartyId: 'c-1', branchId: 'b-1' }))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('transition', () => {
    it('throws BadRequestException for invalid FSM transition', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({ id: 'wo-1', status: 'COMPLETED' });
      await expect(service.transition('org-1', 'wo-1', 'DRAFT', 'emp-1'))
        .rejects.toThrow(BadRequestException);
    });
  });
});
```

---

## Checklist

- [ ] DTOs have `@ApiProperty` on all fields
- [ ] Service validates business rules before DB write
- [ ] FSM transitions go through transition map
- [ ] Stock mutations via `InventoryService.createMovement()`
- [ ] Settlement mutations via `SettlementsService.createTransaction()`
- [ ] `toResponseDto()` maps Prisma model — no raw models in responses
- [ ] Controller uses `@OrgContext()` for tenant isolation
- [ ] Unit tests cover happy path + each error case
- [ ] Module registered in `app.module.ts`
- [ ] `pnpm --filter @sto/api build` passes

---

## Windows & Ukrainian UI Notes for Backend

### Ukrainian Error Messages in NestJS
```typescript
// Always throw Ukrainian messages — never English to the client
throw new NotFoundException('Замовлення-наряд не знайдено');
throw new BadRequestException('Неможливо перевести наряд у статус "В роботі" — недостатньо запчастин на складі');
throw new ConflictException('Підйомник вже зайнятий з 10:00 до 12:00');
throw new ForbiddenException('Недостатньо прав для виконання цієї дії');
```

### Locale Middleware (set Accept-Language + timezone header)
```typescript
// apps/api/src/common/middleware/locale.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    req.locale = 'uk-UA';
    req.timezone = 'Europe/Kyiv';
    next();
  }
}
```

### PostgreSQL Ukrainian Full-Text Search
```prisma
// For search on Ukrainian names/descriptions
// Add tsvector column and GIN index
model Counterparty {
  searchVector Unsupported("tsvector")?
  @@index([searchVector], type: Gin)
}
```
```typescript
// Search query with Ukrainian dictionary
const results = await this.prisma.$queryRaw`
  SELECT * FROM counterparties
  WHERE search_vector @@ plainto_tsquery('simple', ${query})
  AND org_id = ${orgId}
  LIMIT 20
`;
```

### Date/Time Handling
```typescript
// Always store in UTC in PostgreSQL
// Convert to Kyiv timezone only in response DTOs or frontend
import { formatInTimeZone } from 'date-fns-tz';

private formatDate(date: Date): string {
  return formatInTimeZone(date, 'Europe/Kyiv', 'dd.MM.yyyy');
}
private formatDateTime(date: Date): string {
  return formatInTimeZone(date, 'Europe/Kyiv', 'dd.MM.yyyy HH:mm');
}
```

### Running on Windows
```powershell
# All pnpm commands work in PowerShell / Git Bash
pnpm --filter @sto/api dev       # starts on http://localhost:3000
# Swagger UI: http://localhost:3000/api/docs
# Hot reload works correctly on Windows with NestJS/Fastify
```
