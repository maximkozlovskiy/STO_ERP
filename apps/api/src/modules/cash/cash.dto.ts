import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// Дзеркалить Prisma-enum (тримаємо локально, щоб DTO не залежав від @prisma/client у валідації).
export enum CashDirectionDto {
  IN = 'IN',
  OUT = 'OUT',
}
export enum CashReasonDto {
  SALE_PAYMENT = 'SALE_PAYMENT',
  SUPPLIER_REFUND_IN = 'SUPPLIER_REFUND_IN',
  ADVANCE_RETURN = 'ADVANCE_RETURN',
  BANK_WITHDRAWAL = 'BANK_WITHDRAWAL',
  OWNER_IN = 'OWNER_IN',
  COLLECTION = 'COLLECTION',
  MANUAL_IN = 'MANUAL_IN',
  REFUND = 'REFUND',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT',
  ADVANCE_ISSUE = 'ADVANCE_ISSUE',
  BANK_DEPOSIT = 'BANK_DEPOSIT',
  OWNER_OUT = 'OWNER_OUT',
  EXPENSE = 'EXPENSE',
  PAYROLL = 'PAYROLL',
  MANUAL_OUT = 'MANUAL_OUT',
}
/** Документ-підстава касової операції (`CASH_BASE_DOCUMENT_VALUES` у @sto/shared). */
export enum CashBaseDocumentDto {
  WorkOrder = 'WorkOrder',
  PurchaseOrder = 'PurchaseOrder',
}

/**
 * Ручна касова операція — опис тіла `POST /cash-registers/:id/operations` для Swagger і
 * `gen:api-types`. Саме тіло запиту валідує спільна zod-схема `cashOperationSchema`
 * (@sto/shared, BR-CASH-016…021); поля тут мусять їй відповідати.
 */
export class CreateCashOperationDto {
  @ApiProperty({ enum: CashDirectionDto })
  @IsEnum(CashDirectionDto)
  direction!: CashDirectionDto;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: CashReasonDto })
  @IsEnum(CashReasonDto)
  reason!: CashReasonDto;

  @ApiPropertyOptional({
    description:
      'Стаття руху коштів. Обовʼязкова для reason=EXPENSE; не задана — береться стаття, за якою закріплено привід',
  })
  @IsOptional()
  @IsUUID()
  expenseCategoryId?: string;

  @ApiPropertyOptional({ description: 'Контрагент — обовʼязковий для приводів оплат і повернень' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional({ description: 'Працівник — обовʼязковий для «під звіт» і повернення' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    enum: CashBaseDocumentDto,
    description: 'Тип документа-підстави (разом із baseDocumentId)',
  })
  @IsOptional()
  @IsEnum(CashBaseDocumentDto)
  baseDocumentType?: CashBaseDocumentDto;

  @ApiPropertyOptional({ description: 'Документ-підстава: наряд або замовлення постачальнику' })
  @IsOptional()
  @IsUUID()
  baseDocumentId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/**
 * Сторно касової операції — опис тіла `POST /cash-registers/:id/operations/:operationId/reverse`
 * для Swagger. Саме тіло валідує спільна zod-схема `cashReversalSchema` (@sto/shared, BR-CASH-023).
 */
export class CashReversalDto {
  @ApiProperty({ description: 'Причина сторно — стає приміткою рядка сторно', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Хто сторнував рядок: рядок сторно, його дата й причина (BR-CASH-023). */
export class CashOperationReversalRefDto {
  @ApiProperty({ description: 'id рядка сторно' }) id!: string;
  @ApiProperty({ description: 'Коли сторновано (ISO)' }) createdAt!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Причина сторно' })
  reason!: string | null;
}

export class CashOperationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() cashRegisterId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) cashShiftId?: string | null;
  @ApiProperty({ enum: CashDirectionDto }) direction!: string;
  @ApiProperty({ description: 'Сума у валюті каси' }) amount!: number;
  @ApiPropertyOptional({ description: 'Сума у базовій валюті (UAH) по курсу на дату операції' })
  amountBase?: number | null;
  @ApiPropertyOptional({ description: 'Застосований курс (base за 1 од. валюти каси)' })
  rateUsed?: number | null;
  @ApiProperty({ enum: CashReasonDto }) reason!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) expenseCategoryId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) expenseCategoryName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) counterpartyId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) counterpartyName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) employeeId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) employeeName?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Платіжний документ рядка: 'Payment' | 'SupplierPayment' | 'PayrollPeriod' | …",
  })
  documentType?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) documentId?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Номер платіжного документа (оплата постачальнику)',
  })
  documentNumber?: string | null;
  @ApiPropertyOptional({
    enum: CashBaseDocumentDto,
    nullable: true,
    description: 'Документ-підстава: тип',
  })
  baseDocumentType?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) baseDocumentId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Номер наряду / замовлення' })
  baseDocumentNumber?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Статус фіскального чека оплати (лише для documentType = 'Payment')",
  })
  fiscalStatus?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Рядок сторно: id рядка, який він сторнує (BR-CASH-023)',
  })
  reversalOfId?: string | null;
  @ApiPropertyOptional({
    type: CashOperationReversalRefDto,
    nullable: true,
    description: 'Рядок сторновано: рядок сторно, дата й причина (у рядку оригіналу)',
  })
  reversedBy?: CashOperationReversalRefDto | null;
  @ApiPropertyOptional({ type: String, nullable: true }) notes?: string | null;
  @ApiProperty() createdAt!: string;
}
