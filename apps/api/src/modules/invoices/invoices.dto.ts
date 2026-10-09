import {
  Matches,
  IsUUID,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsString,
  IsDateString,
  IsEnum,
  IsBooleanString,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceStatus, WorkOrderStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateInvoiceDto {
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() invoiceType?: string;
  // emptyToUndefined gap: date-input reset → 400 without transform.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'Валюта документа (за замовчуванням — базова валюта org)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() invoiceType?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  counterpartyId?: string;
  // emptyToUndefined gap у PATCH-шляху.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  // Мультивалюта (Фаза 3): дозволяє зміну валюти чернетки з UI. Редагувати можна лише
  // DRAFT (guard у service.update) — CHARGE ще не нарахований, тож totalAmountBase/rateUsed
  // перерахує transition() при виставленні (DRAFT→SENT), той самий lazy-патерн.
  @ApiPropertyOptional({ description: 'Валюта документа' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;
}

const INV_TRANSITION_STATUSES = ['SENT', 'PAID', 'CANCELLED'] as const;
export type InvTransitionStatus = (typeof INV_TRANSITION_STATUSES)[number];

export class TransitionInvoiceDto {
  @ApiProperty({ enum: INV_TRANSITION_STATUSES })
  @IsEnum(INV_TRANSITION_STATUSES)
  status!: InvTransitionStatus;
}

export class CreateInvoiceLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) unitPrice!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) vatRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ description: 'ID одиниці виміру з GoodUoM товару' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class UpdateInvoiceLineDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.001) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) vatRate?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ description: 'ID одиниці виміру з GoodUoM товару' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class InvoiceLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional() goodId?: string | null;
  @ApiPropertyOptional() workId?: string | null;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() vatRate!: number;
  @ApiProperty() priceWithoutVat!: number;
  @ApiProperty() vatAmount!: number;
  @ApiProperty() priceWithVat!: number;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: string;
}

export class InvoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: InvoiceStatus }) status!: InvoiceStatus;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() totalWithoutVat!: number;
  @ApiProperty() totalVat!: number;
  @ApiProperty() totalWithVat!: number;
  // Мультивалюта (Фаза 3): валюта документа + base-сума + курс. null → історичні/base.
  @ApiPropertyOptional() currencyId?: string | null;
  @ApiPropertyOptional() currencyCode?: string | null;
  @ApiPropertyOptional() totalAmountBase?: number | null;
  @ApiPropertyOptional() rateUsed?: number | null;
  // Крок 4 (кодогенерація): було `invoiceType?: string`, але toDto повертає `inv.invoiceType`
  // — колонка nullable у Prisma. Згенерований тип тепер відповідає реальній відповіді.
  @ApiPropertyOptional() invoiceType?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() dueDate?: string | null;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiPropertyOptional() paidAmount?: number;
  @ApiPropertyOptional({ type: [InvoiceLineResponseDto] }) lines?: InvoiceLineResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Set when the invoice is soft-deleted' })
  deletedAt?: string | null;
}

/**
 * Відповідь GET /invoices/from-work-order/:workOrderId/find — ВУЖЧИЙ зріз рахунку
 * для invoice-slot картки наряду (не повний InvoiceResponseDto).
 * Крок 4 аудиту: форма була лише inline-типом у сервісі, тож у Swagger (і в згенерованих
 * типах) її не було зовсім. Тепер це явний DTO — єдине джерело правди для фронта.
 */
export class InvoiceByWorkOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: InvoiceStatus }) status!: InvoiceStatus;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional({ nullable: true }) currencyCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) totalAmountBase!: number | null;
  @ApiPropertyOptional({ nullable: true }) rateUsed!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-datetime (НЕ YYYY-MM-DD, на відміну від InvoiceResponseDto.documentDate)',
  })
  documentDate!: string | null;
}

export class PaginatedInvoicesDto {
  @ApiProperty({ type: [InvoiceResponseDto] }) items!: InvoiceResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class InvoiceQueryDto {
  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

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
    enum: ['documentDate', 'createdAt', 'dueDate', 'amount'],
  })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt', 'dueDate', 'amount'])
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

// ─── Linked documents (batch counts) ────────────────────────
// §2.3 Input validation: без DTO @Body() приймав довільний JSON → DoS-вектор
// (мільйон IDs у where: { in: [...] } спричиняє важкий B-tree lookup) + потенційно
// non-UUID значення доходили до Prisma. ArrayMaxSize обмежує batch до page-size+запас.

export class LinkedCountsDto {
  @ApiProperty({ type: [String], description: 'UUID документів (макс. 500)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];
}

// ─── Linked documents (detail) ─────────────────────────────
// Раніше inline-форма → `200: {}` у Swagger. DTO-класи (НЕ interface — Swagger
// їх не бачить, docs/GOTCHAS.md) дають web згенерований тип замість рукописного
// дубля у `lib/linked-configs.tsx`.
// Секції повертаються масивами навіть для 0..1 елемента — так панель
// `LinkedDocumentsPanel` рендерить усі секції однаково.

export class InvoiceLinkedWorkOrderRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
}

export class InvoiceLinkedPaymentRowDto {
  @ApiProperty() id!: string;
  // Decimal → number нормалізується у сервісі (`Number(p.amount)`).
  @ApiProperty() amount!: number;
  // Payment.method — рядок, НЕ enum: методи конфігуруються у БД (CLAUDE.md §10).
  @ApiProperty({ description: 'Код способу оплати (PaymentMethodConfig.code)' })
  method!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class InvoiceLinkedCounterpartyRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) firstName!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastName!: string | null;
  @ApiProperty({ type: String, nullable: true }) companyName!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
}

export class InvoiceLinkedDocumentsDto {
  @ApiProperty({ type: [InvoiceLinkedWorkOrderRowDto] })
  workOrder!: InvoiceLinkedWorkOrderRowDto[];
  @ApiProperty({ type: [InvoiceLinkedPaymentRowDto] })
  payments!: InvoiceLinkedPaymentRowDto[];
  @ApiProperty({ type: [InvoiceLinkedCounterpartyRowDto] })
  counterparty!: InvoiceLinkedCounterpartyRowDto[];
}

export class InvoiceLinkedCountsEntryDto {
  @ApiProperty() workOrder!: number;
  @ApiProperty() payments!: number;
  @ApiProperty() counterparty!: number;
}
