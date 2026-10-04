import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response-DTO звітів.
 *
 * НАВІЩО: сім методів `ReportsService` повертали виведені типи, тож у Swagger-документі
 * схем не було — відповідно `openapi-typescript` не мав із чого генерувати типи для web,
 * і фронт описував форму звітів рукописними інтерфейсами. Саме такий розрив уже дав
 * реальний баг в іншому модулі (колонка «Бренд» у залишках завжди показувала «—», бо
 * бек не віддавав поле, а web маскував це кастом).
 *
 * ФОРМА ДЗЕРКАЛИТЬ СЕРВІС ОДИН-В-ОДИН — DTO тут описові (Swagger + кодоген), вони НЕ
 * трансформують відповідь. Якщо сервіс змінить форму, `tsc` зловить розбіжність на
 * типі повернення контролера.
 *
 * Гроші — `number` (копійки через `Money`-бренд усередині сервісу, MP-B13); на транспорті
 * це звичайне JSON-число. `count`-поля цілі. `margin` — ВІДСОТОК, не гроші.
 */

// ─── /reports/revenue ────────────────────────────────────────────────────────

export class RevenueRowDto {
  @ApiProperty({ example: '2026-10-04', description: 'День (Europe/Kyiv, YYYY-MM-DD)' })
  date!: string;
  @ApiProperty({ description: 'Виручка за день' }) revenue!: number;
  @ApiProperty({ description: 'З них роботи' }) labor!: number;
  @ApiProperty({ description: 'З них запчастини' }) parts!: number;
  @ApiProperty({ description: 'Кількість нарядів' }) count!: number;
}

export class RevenueReportDto {
  @ApiProperty({ type: [RevenueRowDto] }) rows!: RevenueRowDto[];
  @ApiProperty({ description: 'Σ виручки за період' }) totalRevenue!: number;
  @ApiProperty({ description: 'Σ нарядів за період' }) totalOrders!: number;
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
}

// ─── /reports/work-orders ────────────────────────────────────────────────────

export class WorkOrdersReportRowDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty({ description: 'Прізвище + ім’я' }) employeeName!: string;
  @ApiProperty({ description: 'Σ норма-годин' }) totalNormoHours!: number;
  @ApiProperty({ description: 'Σ сума робіт' }) totalAmount!: number;
  @ApiProperty({ description: 'Кількість рядків робіт' }) linesCount!: number;
}

export class WorkOrdersReportDto {
  @ApiProperty({ type: [WorkOrdersReportRowDto] }) rows!: WorkOrdersReportRowDto[];
  @ApiProperty() totalNormoHours!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}

// ─── /reports/stock ──────────────────────────────────────────────────────────

export class StockReportItemDto {
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Артикул (може бути відсутній)',
  })
  goodSku?: string | null;
  @ApiProperty({ example: 'шт' }) unit!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ description: 'Залишок (може бути дробовим: літри, кг)' }) quantity!: number;
  @ApiProperty({ description: 'Зарезервовано' }) reserved!: number;
  @ApiProperty({ description: 'Доступно = quantity − reserved' }) available!: number;
  @ApiProperty({ description: 'Вартість за ціною продажу' }) value!: number;
}

export class StockReportMovementDto {
  @ApiProperty({ description: 'RECEIPT | WRITEOFF | TRANSFER | RESERVATION | …' }) type!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ description: 'Може бути відʼємною (списання)' }) quantity!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) documentType?: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class StockReportDto {
  @ApiProperty({ type: [StockReportItemDto] }) stockItems!: StockReportItemDto[];
  @ApiProperty({ type: [StockReportMovementDto], description: 'Останні рухи (до 500)' })
  movements!: StockReportMovementDto[];
  @ApiProperty({ description: 'Σ вартості залишків' }) totalValue!: number;
}

// ─── /reports/profitability ──────────────────────────────────────────────────

export class ProfitabilityReportDto {
  @ApiProperty() totalRevenue!: number;
  @ApiProperty({ description: 'Собівартість = запчастини + роботи' }) totalCost!: number;
  @ApiProperty() totalCostParts!: number;
  @ApiProperty({ description: 'totalLabor × LABOR_COST_RATIO' }) totalCostLabor!: number;
  @ApiProperty({ description: 'Виручка − собівартість' }) grossProfit!: number;
  @ApiProperty({ description: 'ВІДСОТОК (не гроші): grossProfit / totalRevenue × 100' })
  margin!: number;
  @ApiProperty() ordersCount!: number;
  @ApiProperty({ description: 'Скільки запчастин без відомої закупівельної ціни' })
  unknownCostPartsCount!: number;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}

// ─── /reports/settlements ────────────────────────────────────────────────────

export class SettlementsReportRowDto {
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() counterpartyName!: string;
  @ApiProperty({ description: 'CLIENT | SUPPLIER | BOTH' }) type!: string;
  @ApiProperty({ description: '> 0 — дебіторська, < 0 — кредиторська' }) balance!: number;
}

export class SettlementsReportDto {
  @ApiProperty({ type: [SettlementsReportRowDto] }) rows!: SettlementsReportRowDto[];
  @ApiProperty({ description: 'Σ позитивних балансів (нам винні)' }) totalDebit!: number;
  @ApiProperty({ description: 'Σ |негативних| балансів (ми винні)' }) totalCredit!: number;
}

// ─── /reports/load ───────────────────────────────────────────────────────────

export class LoadReportRowDto {
  @ApiProperty() liftId!: string;
  @ApiProperty() liftName!: string;
  @ApiProperty({ description: 'Порожній рядок, якщо зону не задано' }) zoneName!: string;
  @ApiProperty({ description: 'Кількість слотів за період' }) totalSlots!: number;
  @ApiProperty({ description: 'Σ годин зайнятості' }) totalHours!: number;
  @ApiProperty({ description: 'ВІДСОТОК завантаження (може перевищувати 100)' })
  loadPercent!: number;
}

export class LoadReportDto {
  @ApiProperty({ type: [LoadReportRowDto] }) rows!: LoadReportRowDto[];
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ description: 'Днів у періоді (мінімум 1) — база для loadPercent' })
  totalDays!: number;
}

// ─── /reports/vat ────────────────────────────────────────────────────────────

export class VatReportDto {
  @ApiProperty({ description: 'ПДВ у виставлених рахунках' }) invoiced!: number;
  @ApiProperty({ description: 'ПДВ у закупках' }) purchases!: number;
  @ApiProperty({ description: 'Чисте ПДВ = invoiced − purchases' }) net!: number;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}
