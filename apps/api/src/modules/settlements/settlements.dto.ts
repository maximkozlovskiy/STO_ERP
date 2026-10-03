import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SettlementTransactionType } from '@prisma/client';

export class CreateReconciliationActDto {
  @ApiProperty({ example: '2026-01-01' }) @IsDateString() periodFrom!: string;
  @ApiProperty({ example: '2026-12-31' }) @IsDateString() periodTo!: string;
}

// ─── Response DTOs ─────────────────────────────────────────
// Раніше всі 4 роути повертали inline-форми → `200: {}` у Swagger. Класи (НЕ
// interface — Swagger їх не бачить, docs/GOTCHAS.md) дають web згенерований тип.

export class SettlementBalanceDto {
  @ApiProperty({ description: 'Баланс у базовій валюті організації' }) balance!: number;
  @ApiProperty() counterpartyId!: string;
}

export class SettlementTransactionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: SettlementTransactionType }) type!: SettlementTransactionType;
  @ApiProperty({ description: 'Сума у валюті транзакції' }) amount!: number;
  // Мультивалюта (Фаза 2): null → історичні рядки у базовій валюті.
  @ApiProperty({ type: String, nullable: true }) currencyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) currencyCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) amountBase!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rateUsed!: number | null;
  // documentType — рядок, НЕ enum: назва моделі-джерела ('Payment', 'Invoice', …).
  @ApiProperty({ type: String, nullable: true }) documentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class PaginatedSettlementTransactionsDto {
  @ApiProperty({ type: [SettlementTransactionDto] }) items!: SettlementTransactionDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class ReconciliationActDto {
  @ApiProperty() id!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) periodFrom!: string;
  @ApiProperty({ type: String, format: 'date-time' }) periodTo!: string;
  @ApiProperty() openingBalance!: number;
  @ApiProperty() closingBalance!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

// Рядок snapshotJson — це НЕ SettlementTransactionDto: знімок зберігає лише
// те, що потрібно для друку акта. Немає `id`, `notes`, `currencyCode`, а дата
// лежить у `date`, не в `createdAt`. Web раніше типував відповідь як
// `RecAct & { transactions: Transaction[] }` — тип обіцяв поля, яких у знімку
// немає (працювало лише тому, що читався самий `.length`).
export class ReconciliationActSnapshotRowDto {
  @ApiProperty({ type: String, format: 'date-time' }) date!: string;
  @ApiProperty({ enum: SettlementTransactionType }) type!: SettlementTransactionType;
  @ApiProperty({ description: 'Сума у валюті транзакції' }) amount!: number;
  @ApiProperty({ description: 'Сума у базовій валюті (фолбек — amount)' }) amountBase!: number;
  @ApiProperty({ type: String, nullable: true }) currencyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
}

export class ReconciliationActDetailDto extends ReconciliationActDto {
  @ApiProperty({ type: [ReconciliationActSnapshotRowDto] })
  transactions!: ReconciliationActSnapshotRowDto[];
}
