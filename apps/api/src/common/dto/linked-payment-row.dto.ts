import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentSourceType } from '@prisma/client';

/**
 * Рядок оплати в «Пов'язаних документах» наряду й рахунку — одна форма для обох панелей
 * (`toLinkedPaymentRows`), тож і одне оголошення (CI-гейт нових клонів).
 */
export class LinkedPaymentRowDto {
  @ApiProperty() id!: string;
  // Decimal → number нормалізується у сервісі (`Number(p.amount)`).
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
  // (BR-PAY-024, `paymentsInCashDesk` — та сама перевірка, що відмовляє `POST /payments/:id/reverse`).
  @ApiProperty() inCashDesk!: boolean;
  // Валюта оплати (Bug #1018); null — базова валюта (оплата без `currencyId`).
  @ApiProperty({ type: String, nullable: true }) currencyCode!: string | null;
}
