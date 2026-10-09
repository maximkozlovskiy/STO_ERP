import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  Matches,
  MaxLength,
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
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';
import { LIST_SEARCH_MAX_LENGTH } from '../../common/utils/like-pattern';

// Допустимі значення enum-ів для валідації query/DTO без хардкоду рядків.
export const BANK_TX_MATCH_TYPES = Object.values(
  BankTransactionMatchType,
) as BankTransactionMatchType[];

// BR-BANK-025: тип рознесення залежить від напряму рядка. `match` (вхідні) приймає лише перший
// список — інакше вихідний тип на старому endpoint-і мовчки став би оплатою клієнта.
export const BANK_TX_IN_MATCH_TYPES = [
  'PREPAYMENT',
  'SERVICE',
  'INVOICE',
  'REFUND',
  'OTHER',
] as const satisfies readonly BankTransactionMatchType[];
/** Типи для `reconcile`. TRANSFER — єдиний, що дозволений і для вхідного рядка. */
export const BANK_TX_OUT_MATCH_TYPES = [
  'SUPPLIER_PAYMENT',
  'CLIENT_REFUND',
  'EXPENSE',
  'PAYROLL',
  'TRANSFER',
  'CASH_WITHDRAWAL',
] as const satisfies readonly BankTransactionMatchType[];
export type BankTxOutMatchType = (typeof BANK_TX_OUT_MATCH_TYPES)[number];

/** Як файл виписки задає напрям рядка (BR-BANK-018). */
export const BANK_IMPORT_DIRECTION_MODES = ['SIGN', 'IN', 'OUT'] as const;
export type BankImportDirectionMode = (typeof BANK_IMPORT_DIRECTION_MODES)[number];

/** Довжина причини скасування рознесення / приміток рознесення. */
export const BANK_TX_REASON_MAX_LENGTH = 500;
export const BANK_TX_STATUSES = Object.values(BankTransactionStatus) as BankTransactionStatus[];

/** Причина невідповідності рядка прев'ю (авто-матч). */
export type PreviewMatchStatus = 'matched' | 'ambiguous' | 'notFound' | 'duplicate';
/** Ознака, за якою знайдено збіг (для пояснення оператору). */
export type PreviewMatchReason = 'iban' | 'edrpou' | 'purpose';

/**
 * Кандидат-контрагент для ambiguous-рядка (кілька збігів).
 * Клас, а не interface: Swagger не бачить interface, тож `candidates` у
 * PreviewRowDto доводилось описувати як `items: { type: 'object' }` — і форма
 * кандидата зникала зі згенерованих типів web.
 */
export class PreviewCandidateDto {
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() counterpartyName!: string;
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

  // BR-BANK-018: напрям рядка. SIGN (типово) — за знаком суми в `amountCol` (від'ємна = вихідний)
  // або, якщо задано `debitCol`, за тим, у якій із двох колонок стоїть сума: `amountCol` —
  // надходження, `debitCol` — списання. IN / OUT — увесь файл одного напряму, знак ігнорується.
  @ApiPropertyOptional({ enum: BANK_IMPORT_DIRECTION_MODES, default: 'SIGN' })
  @IsOptional()
  @IsIn(BANK_IMPORT_DIRECTION_MODES)
  directionMode?: BankImportDirectionMode;

  @ApiPropertyOptional({ description: 'Окрема колонка суми списання (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'err.dto.bankStatement.col.int' })
  @Min(1, { message: 'err.dto.bankStatement.col.min' })
  debitCol?: number;
}

/** Один рядок прев'ю імпорту виписки з результатом авто-матчу. */
export class PreviewRowDto {
  @ApiProperty() rowIndex!: number;
  @ApiProperty() operationDate!: string;
  @ApiProperty({ enum: BankTransactionDirection }) direction!: BankTransactionDirection;
  @ApiProperty({ description: 'Завжди додатна; напрям — у `direction`' }) amount!: number;
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
  @ApiProperty({ type: [PreviewCandidateDto] })
  candidates!: PreviewCandidateDto[];
  // Той самий рахунок, дата, сума й напрям уже є серед внесених ВРУЧНУ платежів — імовірний дубль
  // (у ручного рядка інший externalId, тож ключ ідемпотентності його не зловить).
  @ApiProperty() possibleManualDuplicate!: boolean;
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
  // BR-BANK-017: сума завжди додатна, напрям — окремим полем (типово вхідний).
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional({ enum: BankTransactionDirection, default: 'IN' })
  @IsOptional()
  @IsEnum(BankTransactionDirection)
  direction?: BankTransactionDirection;
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

  @ApiProperty({ enum: BANK_TX_IN_MATCH_TYPES })
  @IsIn(BANK_TX_IN_MATCH_TYPES, { message: 'err.dto.bankStatement.type.invalid' })
  type!: (typeof BANK_TX_IN_MATCH_TYPES)[number];

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

// ─── Ручне внесення (BR-BANK-023) ─────────────────────────────────────────────

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBankTransactionDto {
  @ApiProperty()
  @IsUUID('4', { message: 'err.dto.bankStatement.bankAccountId.uuid' })
  bankAccountId!: string;

  @ApiProperty({ enum: BankTransactionDirection })
  @IsEnum(BankTransactionDirection)
  direction!: BankTransactionDirection;

  @ApiProperty({ description: 'Сума у валюті рахунку, завжди додатна' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  // Дата операції — календарна дата БЕЗ часу (BR-BANK-021).
  @ApiProperty({ example: '2026-10-09' })
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  operationDate!: string;

  // Контрагент з платіжки: платник для вхідного, отримувач для вихідного (BR-BANK-020).
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(200)
  payerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(34)
  payerIban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(12)
  payerEdrpou?: string;

  @ApiPropertyOptional({ description: 'Призначення платежу' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(BANK_TX_REASON_MAX_LENGTH)
  purpose?: string;
}

// ─── Рознесення вихідного платежу (BR-BANK-025…034) ───────────────────────────

/**
 * Один DTO на всі види рознесення: які поля обов'язкові, визначає `type` — це перевіряє сервіс
 * (400 до будь-якого запису). Суму, рахунок, валюту й дату сервіс бере З РЯДКА, не з запиту.
 *
 * | type             | обов'язкове                         | необов'язкове                     |
 * | SUPPLIER_PAYMENT | supplierPaymentId АБО counterpartyId | purchaseOrderId (лише з новою)    |
 * | CLIENT_REFUND    | counterpartyId                      |                                   |
 * | EXPENSE          | expenseCategoryId                   | counterpartyId (довідково)        |
 * | PAYROLL          | payrollPeriodId                     | employeeId                        |
 * | TRANSFER         | transferBankAccountId               |                                   |
 * | CASH_WITHDRAWAL  | cashRegisterId                      |                                   |
 */
export class ReconcileTransactionDto {
  @ApiProperty({ enum: BANK_TX_OUT_MATCH_TYPES })
  @IsIn(BANK_TX_OUT_MATCH_TYPES, { message: 'err.dto.bankStatement.type.invalid' })
  type!: BankTxOutMatchType;

  @ApiPropertyOptional({ description: 'Постачальник / клієнт / довідковий контрагент витрати' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional({ description: 'Наявна проведена оплата постачальнику — лише прив’язка' })
  @IsOptional()
  @IsUUID()
  supplierPaymentId?: string;

  @ApiPropertyOptional({ description: 'Замовлення постачальнику для НОВОЇ оплати' })
  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() expenseCategoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() payrollPeriodId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() transferBankAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cashRegisterId?: string;
}

/** BR-BANK-039: скасування рознесення — причина обов'язкова. */
export class UnreconcileTransactionDto {
  @ApiProperty({ maxLength: BANK_TX_REASON_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'err.dto.bankStatement.unmatchReason.required' })
  @MaxLength(BANK_TX_REASON_MAX_LENGTH)
  reason!: string;
}

/** Проведена оплата постачальнику, до якої можна прив'язати вихідний рядок (BR-BANK-027). */
export class SupplierPaymentCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ description: 'YYYY-MM-DD' }) documentDate!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() supplierId!: string;
  @ApiProperty() supplierName!: string;
  @ApiPropertyOptional() purchaseOrderId?: string | null;
  @ApiPropertyOptional() purchaseOrderNumber?: string | null;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export class ListQueryDto {
  @ApiPropertyOptional({ enum: BANK_TX_STATUSES })
  @IsOptional()
  @IsIn(BANK_TX_STATUSES)
  status?: BankTransactionStatus;

  // Вкладки списку «Вхідні» / «Вихідні». Без параметра — обидва напрямки.
  @ApiPropertyOptional({ enum: BankTransactionDirection })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(BankTransactionDirection)
  direction?: BankTransactionDirection;

  @ApiPropertyOptional({ description: 'Пошук: платник, призначення, IBAN або ЄДРПОУ платника' })
  @IsOptional()
  @IsString()
  @MaxLength(LIST_SEARCH_MAX_LENGTH)
  q?: string;

  // Дата операції — `@db.Date` (дата без часу): межі порівнюються датами, без зсуву на пояс.
  // Порожній рядок = «межі немає» (як у складських документах, оплатах, рухах і касі).
  @ApiPropertyOptional({ description: 'Дата операції від (YYYY-MM-DD), включно' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Дата операції до (YYYY-MM-DD), включно' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  dateTo?: string;

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
  // ── Рознесення: посилання й підписи для колонки «Рознесено як» (join-и list(); null без них) ──
  @ApiPropertyOptional() counterpartyName?: string | null;
  @ApiPropertyOptional() supplierPaymentId?: string | null;
  @ApiPropertyOptional() supplierPaymentNumber?: string | null;
  @ApiPropertyOptional() expenseCategoryId?: string | null;
  @ApiPropertyOptional() expenseCategoryName?: string | null;
  @ApiPropertyOptional() payrollPeriodId?: string | null;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) payrollPeriodStart?: string | null;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) payrollPeriodEnd?: string | null;
  @ApiPropertyOptional() employeeId?: string | null;
  @ApiPropertyOptional() employeeName?: string | null;
  @ApiPropertyOptional() transferBankAccountId?: string | null;
  @ApiPropertyOptional() transferBankAccountName?: string | null;
  @ApiPropertyOptional() cashOperationId?: string | null;
  @ApiPropertyOptional() matchedAt?: string | null;
  // Останнє скасування рознесення (BR-BANK-039).
  @ApiPropertyOptional() unmatchReason?: string | null;
  @ApiPropertyOptional() unmatchedAt?: string | null;
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
  supplierPaymentId?: string | null;
  expenseCategoryId?: string | null;
  payrollPeriodId?: string | null;
  employeeId?: string | null;
  transferBankAccountId?: string | null;
  cashOperationId?: string | null;
  matchedAt?: Date | null;
  unmatchReason?: string | null;
  unmatchedAt?: Date | null;
  // Опційний join рахунку-отримувача (коли list() робить include bankAccount).
  bankAccount?: { name: string; ibanUA: string; currency?: { code: string } | null } | null;
  // Опційні join-и рознесення (list() / відповіді reconcile).
  counterparty?: {
    companyName: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  supplierPayment?: { number: string } | null;
  expenseCategory?: { name: string } | null;
  payrollPeriod?: { periodStart: Date; periodEnd: Date } | null;
  employee?: { firstName: string; lastName: string } | null;
  transferBankAccount?: { name: string } | null;
}

const ymd = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString().slice(0, 10) : null;
const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : null;

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
    counterpartyName: tx.counterparty
      ? tx.counterparty.companyName ||
        [tx.counterparty.lastName, tx.counterparty.firstName].filter(Boolean).join(' ') ||
        null
      : null,
    supplierPaymentId: tx.supplierPaymentId ?? null,
    supplierPaymentNumber: tx.supplierPayment?.number ?? null,
    expenseCategoryId: tx.expenseCategoryId ?? null,
    expenseCategoryName: tx.expenseCategory?.name ?? null,
    payrollPeriodId: tx.payrollPeriodId ?? null,
    payrollPeriodStart: ymd(tx.payrollPeriod?.periodStart),
    payrollPeriodEnd: ymd(tx.payrollPeriod?.periodEnd),
    employeeId: tx.employeeId ?? null,
    employeeName: tx.employee
      ? [tx.employee.lastName, tx.employee.firstName].filter(Boolean).join(' ')
      : null,
    transferBankAccountId: tx.transferBankAccountId ?? null,
    transferBankAccountName: tx.transferBankAccount?.name ?? null,
    cashOperationId: tx.cashOperationId ?? null,
    matchedAt: iso(tx.matchedAt),
    unmatchReason: tx.unmatchReason ?? null,
    unmatchedAt: iso(tx.unmatchedAt),
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
