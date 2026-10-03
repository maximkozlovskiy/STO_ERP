import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BankTransactionDirection,
  BankTransactionMatchType,
  BankTransactionSource,
  BankTransactionStatus,
  Prisma,
} from '@prisma/client';

// Допустимі значення enum-ів для валідації query/DTO без хардкоду рядків.
export const BANK_TX_MATCH_TYPES = Object.values(
  BankTransactionMatchType,
) as BankTransactionMatchType[];
export const BANK_TX_STATUSES = Object.values(BankTransactionStatus) as BankTransactionStatus[];

/** Причина невідповідності рядка прев'ю (авто-матч). */
export type PreviewMatchStatus = 'matched' | 'ambiguous' | 'notFound' | 'duplicate';
/** Ознака, за якою знайдено збіг (для пояснення оператору). */
export type PreviewMatchReason = 'iban' | 'edrpou' | 'purpose';

/** Кандидат-контрагент для ambiguous-рядка (кілька збігів). */
export interface PreviewCandidateDto {
  counterpartyId: string;
  counterpartyName: string;
}

/**
 * Мапінг колонок файлу виписки (1-based індекси). Числові поля приходять рядками з form-data —
 * @Type(() => Number) коерсить. startRow — рядок першої транзакції. Дзеркалить xlsx PreviewImportDto.
 * ПРИМІТКА: клас використовується як тип; multipart-поля контролер парсить вручну (як xlsx.controller),
 * а class-validator-декоратори документують інваріанти й слугують для JSON-варіанту.
 */
export class PreviewImportColumnMapping {
  @ApiPropertyOptional({ default: 1, description: 'Рядок першої транзакції (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.startRow.int' })
  @Min(1, { message: 'err.dto.bankStatement.startRow.min' })
  startRow: number = 1;

  @ApiProperty({ description: 'Колонка дати операції (1-based)' })
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.dateCol.int' })
  @Min(1, { message: 'err.dto.bankStatement.dateCol.min' })
  dateCol!: number;

  @ApiProperty({ description: 'Колонка суми (1-based)' })
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.amountCol.int' })
  @Min(1, { message: 'err.dto.bankStatement.amountCol.min' })
  amountCol!: number;

  @ApiProperty({ description: 'Колонка зовнішнього ідентифікатора транзакції (1-based)' })
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.externalIdCol.int' })
  @Min(1, { message: 'err.dto.bankStatement.externalIdCol.min' })
  externalIdCol!: number;

  @ApiPropertyOptional({ description: 'Колонка назви платника (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.col.int' })
  @Min(1, { message: 'err.dto.bankStatement.col.min' })
  payerNameCol?: number;

  @ApiPropertyOptional({ description: 'Колонка IBAN платника (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.col.int' })
  @Min(1, { message: 'err.dto.bankStatement.col.min' })
  payerIbanCol?: number;

  @ApiPropertyOptional({ description: 'Колонка ЄДРПОУ платника (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.col.int' })
  @Min(1, { message: 'err.dto.bankStatement.col.min' })
  payerEdrpouCol?: number;

  @ApiPropertyOptional({ description: 'Колонка призначення платежу (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.col.int' })
  @Min(1, { message: 'err.dto.bankStatement.col.min' })
  purposeCol?: number;
}

/** Один рядок прев'ю імпорту виписки з результатом авто-матчу. */
export class PreviewRowDto {
  @ApiProperty() rowIndex!: number;
  @ApiProperty() operationDate!: string;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() payerName?: string | null;
  @ApiPropertyOptional() payerIban?: string | null;
  @ApiPropertyOptional() payerEdrpou?: string | null;
  @ApiPropertyOptional() purpose?: string | null;
  @ApiProperty() externalId!: string;
  @ApiProperty({ enum: ['matched', 'ambiguous', 'notFound', 'duplicate'] })
  matchStatus!: PreviewMatchStatus;
  @ApiPropertyOptional() suggestedCounterpartyId?: string | null;
  @ApiPropertyOptional() suggestedCounterpartyName?: string | null;
  @ApiPropertyOptional({ enum: BANK_TX_MATCH_TYPES })
  suggestedMatchType?: BankTransactionMatchType | null;
  @ApiPropertyOptional() suggestedInvoiceId?: string | null;
  @ApiPropertyOptional({ enum: ['iban', 'edrpou', 'purpose'] })
  matchReason?: PreviewMatchReason | null;
  @ApiPropertyOptional() matchConfidence?: number | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  candidates!: PreviewCandidateDto[];
}

export class PreviewImportResponseDto {
  @ApiProperty({ type: [PreviewRowDto] }) rows!: PreviewRowDto[];
}

// ─── Apply ──────────────────────────────────────────────────────────────────────

export class ApplyRowDto {
  @ApiProperty() @IsString() @IsNotEmpty() externalId!: string;
  @ApiProperty({ description: 'Дата операції (ISO або YYYY-MM-DD)' })
  @IsString()
  @IsNotEmpty()
  operationDate!: string;
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() payerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() payerIban?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() payerEdrpou?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() purpose?: string;
  // Сирий рядок виписки (діагностика) — довільний JSON-об'єкт.
  @ApiPropertyOptional() @IsOptional() rawData?: Prisma.InputJsonValue;
}

export class ApplyImportDto {
  @ApiProperty()
  @IsUUID('4', { message: 'err.dto.bankStatement.bankAccountId.uuid' })
  bankAccountId!: string;

  @ApiProperty({ type: [ApplyRowDto] })
  @IsArray()
  @ArrayMaxSize(1000, { message: 'err.dto.bankStatement.rows.max' })
  @ValidateNested({ each: true })
  @Type(() => ApplyRowDto)
  rows!: ApplyRowDto[];
}

export class ApplyImportResultDto {
  @ApiProperty() created!: number;
  @ApiProperty() skipped!: number;
}

// ─── Match / Ignore ───────────────────────────────────────────────────────────

export class MatchTransactionDto {
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;

  @ApiProperty({ enum: BANK_TX_MATCH_TYPES })
  @IsIn(BANK_TX_MATCH_TYPES, { message: 'err.dto.bankStatement.type.invalid' })
  type!: BankTransactionMatchType;

  @ApiPropertyOptional({ description: 'Обов’язковий для type=INVOICE' })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;
}

export class IgnoreTransactionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'err.dto.bankStatement.reason.required' })
  reason!: string;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export class ListQueryDto {
  @ApiPropertyOptional({ enum: BANK_TX_STATUSES })
  @IsOptional()
  @IsIn(BANK_TX_STATUSES)
  status?: BankTransactionStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

// ─── Response ─────────────────────────────────────────────────────────────────

export class BankTransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() bankAccountId!: string;
  // Prisma enum-колонка — у DTO був `string` (у Swagger без переліку).
  @ApiProperty({ enum: BankTransactionDirection }) direction!: BankTransactionDirection;
  @ApiProperty() amount!: number;
  @ApiProperty() currencyId!: string;
  @ApiPropertyOptional() amountBase?: number | null;
  @ApiPropertyOptional() rateUsed?: number | null;
  @ApiProperty() operationDate!: string;
  @ApiPropertyOptional() payerName?: string | null;
  @ApiPropertyOptional() payerIban?: string | null;
  @ApiPropertyOptional() payerEdrpou?: string | null;
  @ApiPropertyOptional() purpose?: string | null;
  @ApiProperty() externalId!: string;
  @ApiProperty({ enum: BankTransactionSource }) source!: BankTransactionSource;
  @ApiProperty({ enum: BankTransactionStatus }) status!: BankTransactionStatus;
  @ApiPropertyOptional({ enum: BankTransactionMatchType })
  matchedType?: BankTransactionMatchType | null;
  @ApiPropertyOptional() counterpartyId?: string | null;
  @ApiPropertyOptional() paymentId?: string | null;
  @ApiPropertyOptional() matchConfidence?: number | null;
  @ApiPropertyOptional() ignoreReason?: string | null;
  @ApiProperty() createdAt!: string;
  // Назва/IBAN нашого рахунку-отримувача (join, коли list() робить include bankAccount) — для колонки
  // «Рахунок» у списку платежів. null коли include не запитано.
  @ApiPropertyOptional() bankAccountName?: string | null;
  @ApiPropertyOptional() bankAccountIban?: string | null;
  // Код валюти рахунку-отримувача (join) — для символу валюти суми у UI (multi-bank: USD/EUR).
  @ApiPropertyOptional() bankAccountCurrencyCode?: string | null;
}

export class PaginatedBankTransactionsDto {
  @ApiProperty({ type: [BankTransactionResponseDto] }) items!: BankTransactionResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

/** Форма рядка транзакції для mapper (звужена — лише поля, що читає toBankTransactionResponseDto). */
interface BankTransactionRow {
  id: string;
  orgId: string;
  bankAccountId: string;
  direction: BankTransactionDirection;
  amount: Prisma.Decimal;
  currencyId: string;
  amountBase: Prisma.Decimal | null;
  rateUsed: Prisma.Decimal | null;
  operationDate: Date;
  payerName: string | null;
  payerIban: string | null;
  payerEdrpou: string | null;
  purpose: string | null;
  externalId: string;
  // Prisma-колонки enum-типу; руками розширений `string` ховав перелік від DTO.
  source: BankTransactionSource;
  status: BankTransactionStatus;
  matchedType: BankTransactionMatchType | null;
  counterpartyId: string | null;
  paymentId: string | null;
  matchConfidence: Prisma.Decimal | null;
  ignoreReason: string | null;
  createdAt: Date;
  // Опційний join рахунку-отримувача (коли list() робить include bankAccount).
  bankAccount?: { name: string; ibanUA: string; currency?: { code: string } | null } | null;
}

/** Mapper Prisma-рядка → response DTO. Decimal→number через Number(), Date→ISO. */
export function toBankTransactionResponseDto(tx: BankTransactionRow): BankTransactionResponseDto {
  return {
    id: tx.id,
    orgId: tx.orgId,
    bankAccountId: tx.bankAccountId,
    direction: tx.direction,
    amount: Number(tx.amount),
    currencyId: tx.currencyId,
    amountBase: tx.amountBase != null ? Number(tx.amountBase) : null,
    rateUsed: tx.rateUsed != null ? Number(tx.rateUsed) : null,
    operationDate:
      tx.operationDate instanceof Date ? tx.operationDate.toISOString() : tx.operationDate,
    payerName: tx.payerName ?? null,
    payerIban: tx.payerIban ?? null,
    payerEdrpou: tx.payerEdrpou ?? null,
    purpose: tx.purpose ?? null,
    externalId: tx.externalId,
    source: tx.source,
    status: tx.status,
    matchedType: tx.matchedType ?? null,
    counterpartyId: tx.counterpartyId ?? null,
    paymentId: tx.paymentId ?? null,
    matchConfidence: tx.matchConfidence != null ? Number(tx.matchConfidence) : null,
    ignoreReason: tx.ignoreReason ?? null,
    createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : tx.createdAt,
    bankAccountName: tx.bankAccount?.name ?? null,
    bankAccountIban: tx.bankAccount?.ibanUA ?? null,
    bankAccountCurrencyCode: tx.bankAccount?.currency?.code ?? null,
  };
}

// ─── Raw preview (сира сітка для column-mapping) ──────────────────────────────
// Повертався inline `{ totalRows, columnCount, rows }` → у Swagger відсутній.

export class RawPreviewResponseDto {
  @ApiProperty({ description: 'Скільки рядків у файлі всього' }) totalRows!: number;
  @ApiProperty({ description: 'Максимальна кількість колонок серед показаних рядків' })
  columnCount!: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    description: 'Перші рядки файлу як текстова сітка',
  })
  rows!: string[][];
}
