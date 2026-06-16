import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsInt,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsISO8601,
  IsDateString,
  IsBoolean,
  IsBooleanString,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// ─── Work Order ───────────────────────────────────────────

export class CreateWorkOrderDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiProperty()
  @IsUUID()
  vehicleId!: string;
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;

  @ApiPropertyOptional({ description: 'Договір контрагента (SALE). Авто-вибір якщо не передано.' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;

  // Bug #257: emptyToUndefined gap — sprint cycle 3 пропустив work-orders DTO.
  // Frontend селекти що шлють `''` при default state → 400 без трансформу.
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @ApiPropertyOptional({ enum: RepairCategory })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RepairCategory)
  repairCategory?: RepairCategory;

  // Bug #258: emptyToUndefined gap — datetime-local input шле `''` при reset → 400.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  plannedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'Підйомник' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;

  @ApiPropertyOptional({ description: 'Планові нормогодини' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedHours?: number;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) outMileage?: number;

  // Bug #259: emptyToUndefined gap у PATCH-шляху.
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @ApiPropertyOptional({ enum: RepairCategory })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RepairCategory)
  repairCategory?: RepairCategory;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() clientApproval?: boolean;

  // Nullable: passing `null` explicitly clears the field; omitting keeps it.
  // emptyToUndefined: `''` від UI шле скинуте поле → undefined → omit (keeps existing).
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  plannedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  dueDate?: string | null;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'Підйомник', type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string | null;

  @ApiPropertyOptional({ description: 'Планові нормогодини', type: Number, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedHours?: number | null;

  @ApiPropertyOptional({ description: 'Фактичні нормогодини', type: Number, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualHours?: number | null;
}

export class TransitionWorkOrderDto {
  @ApiProperty({ enum: WorkOrderStatus }) @IsEnum(WorkOrderStatus) status!: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class WorkOrderQueryDto {
  @ApiPropertyOptional({ enum: WorkOrderStatus })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  branchId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  counterpartyId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  vehicleId?: string;

  // F6: "Мої наряди" chip — filter by assigned mechanic. The filter joins through workOrderLines.employeeId,
  // so an employee sees an order if ANY of its line items reference them as the executor.
  @ApiPropertyOptional({ description: 'Фільтр за виконавцем (через рядки робіт)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Пошук за номером або назвою контрагента' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: [
      'MAINTENANCE',
      'CURRENT_REPAIR',
      'MAJOR_REPAIR',
      'BODY_REPAIR',
      'DIAGNOSTICS',
      'WARRANTY',
      'SEASONAL',
    ],
  })
  @IsOptional()
  @IsEnum([
    'MAINTENANCE',
    'CURRENT_REPAIR',
    'MAJOR_REPAIR',
    'BODY_REPAIR',
    'DIAGNOSTICS',
    'WARRANTY',
    'SEASONAL',
  ])
  repairCategory?: string;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

  // Bug #337: @IsISO8601() приймає datetime рядки з часовою компонентою → хибна фільтрація.
  // @IsDateString() приймає лише YYYY-MM-DD формат — відповідно до решти модулів.
  @ApiPropertyOptional({ description: 'Дата документа від (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Дата документа до (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Поле сортування',
    enum: ['documentDate', 'createdAt', 'plannedAt', 'dueDate', 'totalAmount'],
  })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt', 'plannedAt', 'dueDate', 'totalAmount'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Напрям сортування', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

export class WorkOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
  @ApiProperty({ enum: WorkOrderPriority }) priority!: WorkOrderPriority;
  @ApiPropertyOptional({ enum: RepairCategory }) repairCategory?: RepairCategory | null;
  @ApiProperty() branchId!: string;
  @ApiPropertyOptional() branchName?: string;
  @ApiProperty() vehicleId!: string;
  @ApiPropertyOptional() vehicleSummary?: string;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional({ description: 'Договір контрагента' }) contractId?: string | null;
  @ApiPropertyOptional() contractNumber?: string | null;
  @ApiPropertyOptional({ description: 'Підйомник' }) liftId?: string | null;
  @ApiPropertyOptional({ description: 'Назва підйомника' }) liftName?: string | null;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() inMileage?: number | null;
  @ApiPropertyOptional() outMileage?: number | null;
  @ApiPropertyOptional() plannedAt?: Date | null;
  @ApiPropertyOptional() dueDate?: Date | null;
  @ApiPropertyOptional() plannedHours?: number | null;
  @ApiPropertyOptional() actualHours?: number | null;
  @ApiPropertyOptional() completedAt?: Date | null;
  @ApiProperty() clientApproval!: boolean;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() paidAmount!: number;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ description: 'Є активна гарантія' }) hasActiveWarranty?: boolean;
  @ApiPropertyOptional({ description: 'Найближчий слот у календарі: початок' })
  slotStartAt?: Date | null;
  @ApiPropertyOptional({ description: 'Найближчий слот у календарі: кінець' })
  slotEndAt?: Date | null;
  @ApiPropertyOptional({ description: 'Підйомник слота у календарі' }) slotLiftName?: string | null;
  @ApiPropertyOptional({ description: 'Set when the work order is soft-deleted' })
  deletedAt?: Date | null;
}

export class PaginatedWorkOrdersDto {
  @ApiProperty({ type: [WorkOrderResponseDto] }) items!: WorkOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── Work Order Line ──────────────────────────────────────

export class CreateWorkOrderLineDto {
  @ApiProperty()
  @IsUUID()
  workId!: string;
  @ApiProperty()
  @IsUUID()
  employeeId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) normoHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) actualHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// Bug #521: actualHours виключаємо з PartialType бо нам потрібен ширший тип
// `number | null` (а CreateWorkOrderLineDto.actualHours = `number`). Після Omit
// додаємо явну версію з nullable handling.
export class UpdateWorkOrderLineDto extends PartialType(
  OmitType(CreateWorkOrderLineDto, ['actualHours'] as const),
) {
  // Bug #521: nullable handling — frontend save() надсилає `null` коли користувач
  // очистив inline "Год (факт.)" → без `ValidateIf(o => o.actualHours !== null)`
  // class-validator кидав 400 і будь-який save() з порожнім actualHours лагав
  // partial-PATCH (work-order рівень пройшов, line PATCH — fail → corrupted state).
  // Симетрія з UpdateWorkOrderDto.actualHours (work-orders.dto.ts:148) та Bug #426.
  @ApiPropertyOptional({ description: 'Фактично витрачені години', type: Number, nullable: true })
  @IsOptional()
  @ValidateIf((o: { actualHours?: number | null }) => o.actualHours !== null)
  @IsNumber()
  @Min(0)
  actualHours?: number | null;
}

export class WorkOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() workId!: string;
  @ApiPropertyOptional() workName?: string;
  @ApiProperty() employeeId!: string;
  @ApiPropertyOptional() employeeName?: string;
  @ApiPropertyOptional() liftId?: string | null;
  @ApiProperty() normoHours!: number;
  @ApiPropertyOptional() actualHours?: number | null;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: Date;
}

// ─── Work Order Part ──────────────────────────────────────

export class CreateWorkOrderPartDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional({
    description: 'ID одиниці виміру з GoodUoM. Якщо не передано — базова одиниця товару.',
  })
  @IsOptional()
  @IsUUID('4')
  unitOfMeasureId?: string;
}

export class UpdateWorkOrderPartDto extends PartialType(CreateWorkOrderPartDto) {}

export class WorkOrderPartResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() createdAt!: Date;
}

// ─── Work Order Detail (full card) ───────────────────────

export class WorkOrderDetailDto extends WorkOrderResponseDto {
  @ApiProperty({ type: [WorkOrderLineResponseDto] }) lines!: WorkOrderLineResponseDto[];
  @ApiProperty({ type: [WorkOrderPartResponseDto] }) parts!: WorkOrderPartResponseDto[];
}

// ─── Public Estimate (shared via shareToken — no auth) ────
// IMPORTANT: цей DTO навмисно НЕ містить orgId, всі FK (vehicleId, counterpartyId,
// contractId, branchId, liftId, employeeId), paidAmount, clientApproval, slot*,
// outMileage, dueDate, syncVersion, deletedAt тощо.
// Все що клієнт бачить публічно — обмежено мінімумом для друку кошторису.

export class EstimatePublicLineDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() workName?: string;
  @ApiProperty() normoHours!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() notes?: string | null;
}

export class EstimatePublicPartDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
}

export class EstimatePublicDto {
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
  @ApiPropertyOptional() orgName?: string;
  @ApiPropertyOptional() orgLogoUrl?: string | null;
  @ApiPropertyOptional() branchName?: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() vehicleSummary?: string;
  @ApiPropertyOptional() documentDate?: string | null;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() inMileage?: number | null;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ type: [EstimatePublicLineDto] }) lines!: EstimatePublicLineDto[];
  @ApiProperty({ type: [EstimatePublicPartDto] }) parts!: EstimatePublicPartDto[];
}

// ─── Send estimate SMS (authenticated) ───────────────────
// baseUrl навмисно НЕ приймається з клієнта (open-redirect/phishing ризик):
// сервер сам визначає публічний URL через ConfigService('WEB_PUBLIC_URL').

export class SendEstimateSmsDto {
  // Порожнє тіло — навмисно. Залишено для майбутніх параметрів (lang, channel),
  // class-validator забезпечить що жодні зайві поля не приймаються (whitelist у ValidationPipe).
}

// ─── Linked documents (batch counts) ───────────────────────
// §2.3 Input validation: без DTO @Body() приймав довільний JSON → DoS-вектор
// (мільйон IDs у where: { in: [...] } спричиняє важкий B-tree lookup) + потенційно
// non-UUID значення доходили до Prisma. ArrayMaxSize обмежує batch до page-size+запас.

export class LinkedCountsDto {
  @ApiProperty({ type: [String], description: 'UUID нарядів (макс. 500)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  workOrderIds!: string[];
}
