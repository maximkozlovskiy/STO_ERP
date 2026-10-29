import {
  Matches,
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
// Стелі — місткість колонок (MONEY_AMOUNT_MAX = Decimal(12,2)) і QTY_MAX для кількості/годин:
// понад них 400 з назвою поля, а не 500 `numeric field overflow`. На маршрутах із ZodValidationPipe
// працює та сама стеля спільної схеми; тут — для Swagger і маршрутів на class-validator.
import { MONEY_AMOUNT_MAX, QTY_MAX } from '@sto/shared';
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import {
  CalendarSlotStatus,
  InvoiceStatus,
  PaymentSourceType,
  RepairCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from '@prisma/client';
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

  @ApiPropertyOptional({
    description: 'Договір контрагента (SALE). Авто-вибір якщо не передано.',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;

  // emptyToUndefined gap — sprint cycle 3 пропустив work-orders DTO.
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

  // emptyToUndefined gap — datetime-local input шле `''` при reset → 400.
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

  @ApiPropertyOptional({
    description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'Валюта документа (за замовчуванням — базова валюта org)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;

  @ApiPropertyOptional({ description: 'Підйомник' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;

  @ApiPropertyOptional({ description: 'Планові нормогодини' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(QTY_MAX)
  plannedHours?: number;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) outMileage?: number;

  // emptyToUndefined gap у PATCH-шляху.
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

  // Мультивалюта (Фаза 3): дозволяє зміну валюти документа з UI. totalAmountBase/rateUsed
  // перераховуються лише при наступному recalcTotals (зміна рядка/деталі) — той самий
  // lazy-патерн, що вже існує для documentDate вище.
  @ApiPropertyOptional({ description: 'Валюта документа' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;

  @ApiPropertyOptional({ description: 'Підйомник', type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string | null;

  @ApiPropertyOptional({
    description: 'Планові нормогодини',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(QTY_MAX)
  plannedHours?: number | null;

  @ApiPropertyOptional({
    description: 'Фактичні нормогодини',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(QTY_MAX)
  actualHours?: number | null;
}

export class TransitionWorkOrderDto {
  @ApiProperty({ enum: WorkOrderStatus }) @IsEnum(WorkOrderStatus) status!: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Що можна вкласти у список нарядів (`?include=`). */
export const WO_LIST_INCLUDES = ['lines', 'parts'] as const;
export type WorkOrderListInclude = (typeof WO_LIST_INCLUDES)[number];

export class WorkOrderQueryDto {
  @ApiPropertyOptional({ enum: WorkOrderStatus })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;
  @ApiPropertyOptional({
    enum: WorkOrderStatus,
    isArray: true,
    description:
      'Кілька статусів через кому (IN_PROGRESS,ON_HOLD) — перехід із карток дашборду. ' +
      'Разом зі `status` — перетин.',
  })
  @IsOptional()
  // Повторений параметр Fastify віддає масивом — розбираємо і його, як `statuses` рахунків.
  @Transform(({ value }: { value: unknown }) => {
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap(v => (typeof v === 'string' ? v.split(',') : [v]))
      .map(v => (typeof v === 'string' ? v.trim() : v))
      .filter(v => v !== '' && v != null);
    return parts.length > 0 ? parts : undefined;
  })
  @IsArray()
  @ArrayMaxSize(11)
  @IsEnum(WorkOrderStatus, { each: true })
  statuses?: WorkOrderStatus[];
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
  @ApiPropertyOptional({
    description: 'Фільтр за виконавцем (через рядки робіт)',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    description: 'Пошук за номером або назвою контрагента',
  })
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

  // @IsISO8601() приймає datetime рядки з часовою компонентою → хибна фільтрація.
  // @IsDateString() приймає лише YYYY-MM-DD формат — відповідно до решти модулів.
  @ApiPropertyOptional({ description: 'Дата документа від (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Дата документа до (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
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

  /**
   * Вкладені рядки списку: `lines`, `parts` через кому (`?include=lines,parts`) — для
   * синхронізації планшета механіка, якому потрібні роботи й запчастини без запиту на кожен
   * наряд. Без параметра список такий, як був. Собівартість запчастин у списку не віддається.
   */
  @ApiPropertyOptional({
    description: 'Вкладені дані: lines, parts (через кому)',
    type: String,
    example: 'lines,parts',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @IsIn(WO_LIST_INCLUDES, { each: true })
  include?: WorkOrderListInclude[];
}

/**
 * BR-WO-023: запис наряду перетягнуто в календарі — `PATCH /work-orders/:id/reschedule`.
 * `startAt` — новий початок перетягнутого запису (будь-якого в ланцюжку); наряд зсувається на
 * ту саму різницю. `liftId` — лише коли запис перенесено на рядок іншого підйомника.
 */
export class RescheduleWorkOrderDto {
  @ApiProperty({ description: 'Перетягнутий запис календаря цього наряду' })
  @IsUUID()
  slotId!: string;

  @ApiProperty({ description: 'Новий початок перетягнутого запису (ISO 8601)' })
  @IsISO8601({ strict: true })
  startAt!: string;

  @ApiPropertyOptional({
    description: 'Новий підйомник наряду (рядок, на який перенесено запис)',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string | null;
}

export class WorkOrderRescheduleResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) plannedAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueDate!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) liftId!: string | null;
  @ApiPropertyOptional({
    description: 'Механіка запису знято: не закріплений за новим підйомником (BR-CAL-012)',
  })
  mechanicDropped?: boolean;
  @ApiPropertyOptional({
    enum: ['ON_LEAVE', 'NOT_ON_LIFT', 'UNAVAILABLE'],
    description: 'Причина зняття механіка (лише разом із mechanicDropped)',
  })
  mechanicDroppedReason?: 'ON_LEAVE' | 'NOT_ON_LIFT' | 'UNAVAILABLE';
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
  @ApiPropertyOptional() plannedAt?: string | null;
  @ApiPropertyOptional() dueDate?: string | null;
  @ApiPropertyOptional() plannedHours?: number | null;
  @ApiPropertyOptional() actualHours?: number | null;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiProperty() clientApproval!: boolean;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalActualLabor!: number;
  @ApiProperty() totalParts!: number;
  // BR-WO-007: totalAmount = amount to pay (VAT included), totalNet = without VAT;
  // totalNet + totalVat = totalAmount.
  @ApiProperty() totalNet!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() totalVat!: number;
  @ApiProperty() paidAmount!: number;
  // Мультивалюта (Фаза 3): валюта документа + base-сума + курс. null → історичні/base.
  @ApiPropertyOptional() currencyId?: string | null;
  @ApiPropertyOptional() currencyCode?: string | null;
  @ApiPropertyOptional() totalAmountBase?: number | null;
  @ApiPropertyOptional() rateUsed?: number | null;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Є активна гарантія' })
  hasActiveWarranty?: boolean;
  @ApiPropertyOptional({
    description: 'Найближчий слот у календарі: початок',
  })
  slotStartAt?: string | null;
  @ApiPropertyOptional({
    description: 'Найближчий слот у календарі: кінець',
  })
  slotEndAt?: string | null;
  @ApiPropertyOptional({ description: 'Підйомник слота у календарі' })
  slotLiftName?: string | null;
  @ApiPropertyOptional({ description: 'Set when the work order is soft-deleted' })
  deletedAt?: string | null;
}

export class PaginatedWorkOrdersDto {
  @ApiProperty({ type: () => [WorkOrderListItemDto] }) items!: WorkOrderListItemDto[];
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
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) @Max(QTY_MAX) normoHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(QTY_MAX) actualHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(MONEY_AMOUNT_MAX) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// actualHours виключаємо з PartialType бо нам потрібен ширший тип
// `number | null` (а CreateWorkOrderLineDto.actualHours = `number`). Після Omit
// додаємо явну версію з nullable handling.
export class UpdateWorkOrderLineDto extends PartialType(
  OmitType(CreateWorkOrderLineDto, ['actualHours'] as const),
) {
  // nullable handling — frontend save() надсилає `null` коли користувач
  // очистив inline "Год (факт.)" → без `ValidateIf(o => o.actualHours !== null)`
  // class-validator кидав 400 і будь-який save() з порожнім actualHours лагав
  // partial-PATCH (work-order рівень пройшов, line PATCH — fail → corrupted state).
  // Симетрія з UpdateWorkOrderDto.actualHours (work-orders.dto.ts:148) та Bug #426.
  @ApiPropertyOptional({
    description: 'Фактично витрачені години',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: { actualHours?: number | null }) => o.actualHours !== null)
  @IsNumber()
  @Min(0)
  @Max(QTY_MAX)
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
  @ApiProperty() createdAt!: string;
}

// ─── Work Order Part ──────────────────────────────────────

export class CreateWorkOrderPartDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) @Max(QTY_MAX) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(MONEY_AMOUNT_MAX) price?: number;
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
  @ApiPropertyOptional() goodInternalCode?: string | null;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() goodBrandName?: string | null;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() costPrice?: number | null;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() createdAt!: string;
}

// ─── Work Order Detail (full card) ───────────────────────

export class WorkOrderDetailDto extends WorkOrderResponseDto {
  @ApiProperty({ type: [WorkOrderLineResponseDto] }) lines!: WorkOrderLineResponseDto[];
  @ApiProperty({ type: [WorkOrderPartResponseDto] }) parts!: WorkOrderPartResponseDto[];
}

/** Рядок списку: `lines` / `parts` лише коли їх попросили через `?include=`. */
export class WorkOrderListItemDto extends WorkOrderResponseDto {
  @ApiPropertyOptional({ type: [WorkOrderLineResponseDto] }) lines?: WorkOrderLineResponseDto[];
  @ApiPropertyOptional({ type: [WorkOrderPartResponseDto] }) parts?: WorkOrderPartResponseDto[];
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
  // Planned totals of the estimate; totalAmount = amount to pay (VAT included).
  @ApiProperty() totalNet!: number;
  @ApiProperty() totalVat!: number;
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

// ─── Share token (кошторис за посиланням) ──────────────────────────────
// Раніше метод повертав inline `Promise<{ token: string }>` — у Swagger такої
// форми не було зовсім, тож web не мав згенерованого типу (патерн
// InvoiceByWorkOrderResponseDto).

export class WorkOrderShareTokenResponseDto {
  @ApiProperty({ description: 'Токен публічного кошторису' }) token!: string;
  @ApiProperty({
    description: 'Коли посилання перестане відкриватись (ISO 8601), BR-WO-032',
    format: 'date-time',
  })
  expiresAt!: string;
}

/** BR-WO-032: після відкликання токена й терміну немає. */
export class WorkOrderShareRevokeResponseDto {
  @ApiProperty({ type: String, nullable: true, example: null }) token!: null;
  @ApiProperty({ type: String, nullable: true, example: null }) expiresAt!: null;
}

// ─── Linked documents (detail) ─────────────────────────────
// Раніше `getLinkedDocuments` повертав inline-форму → у Swagger `200: {}`, а web
// тримав рукописні дублі рядків у `lib/linked-configs.tsx` зі слабшими типами
// (`status: string`, `amount: string | number`). DTO-класи (НЕ interface — Swagger
// їх не бачить, див. docs/GOTCHAS.md) закривають обидва розриви.

export class LinkedInvoiceRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: InvoiceStatus }) status!: InvoiceStatus;
  // Decimal → number нормалізується у сервісі (`Number(i.amount)`), тож тип точний.
  @ApiProperty() amount!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  documentDate!: string | null;
}

export class LinkedPaymentRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() amount!: number;
  // Payment.method — рядок, НЕ enum: методи оплати конфігуруються у БД
  // (PaymentMethodConfig), див. CLAUDE.md §10.
  @ApiProperty({ description: 'Код способу оплати (PaymentMethodConfig.code)' })
  method!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  // Стан фіскального чека (QUEUED|DONE|FAILED|SKIPPED); null — фіскалізація не застосовна.
  @ApiPropertyOptional({ type: String, nullable: true }) fiscalStatus?: string | null;
  // Сторно з каси (BR-CASH-024): оплата лишається в переліку з позначкою, у «сплачено» не входить.
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  reversedAt?: string | null;
  // BR-PAY-024: куди лягли гроші — касову оплату сторнують у касі, решту — з «Пов'язаних документів».
  @ApiPropertyOptional({ enum: PaymentSourceType, nullable: true })
  sourceType?: PaymentSourceType | null;
  // Онлайн-оплата QR (є `onlinePaymentIntentId`): сторно тут недоступне (BR-PAY-024).
  @ApiProperty() isOnline!: boolean;
  // Гроші лежать у касі (і стара оплата без `sourceType`, але з рядком каси): сторно — лише в касі
  // (BR-PAY-024, `toLinkedPaymentRows` / `paymentsInCashDesk`).
  @ApiProperty() inCashDesk!: boolean;
}

export class LinkedSlotLiftDto {
  @ApiProperty() name!: string;
}

export class LinkedCalendarSlotRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endAt!: string;
  @ApiProperty({ enum: CalendarSlotStatus }) status!: CalendarSlotStatus;
  @ApiProperty({ type: String, nullable: true }) employeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: LinkedSlotLiftDto, nullable: true }) lift!: LinkedSlotLiftDto | null;
}

export class LinkedWarrantyRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) claimedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class WorkOrderLinkedDocumentsDto {
  @ApiProperty({ type: [LinkedInvoiceRowDto] }) invoices!: LinkedInvoiceRowDto[];
  @ApiProperty({ type: [LinkedPaymentRowDto] }) payments!: LinkedPaymentRowDto[];
  @ApiProperty({ type: [LinkedCalendarSlotRowDto] })
  calendarSlots!: LinkedCalendarSlotRowDto[];
  @ApiProperty({ type: [LinkedWarrantyRowDto] }) warranties!: LinkedWarrantyRowDto[];
}

export class WorkOrderLinkedCountsEntryDto {
  @ApiProperty() invoices!: number;
  @ApiProperty() payments!: number;
  @ApiProperty() calendarSlots!: number;
  @ApiProperty() warranties!: number;
}

// Мапа workOrderId → лічильники описується НЕ класом: клас з index-signature
// Swagger не читає (властивостей для рефлексії немає). Схема задається на
// контролері через `additionalProperties` + `getSchemaPath` — див.
// WorkOrdersController.getLinkedCounts. Сам entry лишається класом, щоб
// потрапити у components.schemas (@ApiExtraModels).
