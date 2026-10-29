import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PNL_EXPENSE_CASH_REASON_OPTIONS,
  PNL_INCOME_CASH_REASON_OPTIONS,
  type CashReasonValue,
} from '@sto/shared';

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
  @ApiProperty({ description: 'Виручка за день БЕЗ ПДВ (Σ totalNet)' }) revenue!: number;
  @ApiProperty({ description: 'ПДВ за день (revenueWithVat − revenue)' }) vat!: number;
  @ApiProperty({ description: 'Виручка за день З ПДВ (Σ totalAmount)' }) revenueWithVat!: number;
  @ApiProperty({ description: 'З них роботи' }) labor!: number;
  @ApiProperty({ description: 'З них запчастини' }) parts!: number;
  @ApiProperty({ description: 'Кількість нарядів' }) count!: number;
}

export class RevenueReportDto {
  @ApiProperty({ type: [RevenueRowDto] }) rows!: RevenueRowDto[];
  @ApiProperty({ description: 'Σ виручки за період БЕЗ ПДВ' }) totalRevenue!: number;
  @ApiProperty({ description: 'Σ ПДВ за період' }) totalVat!: number;
  @ApiProperty({ description: 'Σ виручки за період З ПДВ' }) totalRevenueWithVat!: number;
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
  @ApiProperty({
    description:
      'Товар видалено з каталогу (BR-RPT-032): залишок у звіті й підсумках, картки немає',
  })
  goodDeleted!: boolean;
  @ApiProperty({ example: 'шт' }) unit!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ description: 'Залишок (може бути дробовим: літри, кг)' }) quantity!: number;
  @ApiProperty({ description: 'Зарезервовано' }) reserved!: number;
  @ApiProperty({ description: 'Доступно = quantity − reserved' }) available!: number;
  @ApiProperty({
    description:
      'Вартість за собівартістю (BR-RPT-034): Σ remainingQty × costPrice активних партій; кількість ' +
      'поза партіями — за purchasePrice товару',
  })
  costValue!: number;
  @ApiProperty({ description: 'Вартість за цінами продажу: кількість × salePrice товару' })
  saleValue!: number;
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
  @ApiProperty({ description: 'Σ costValue — залишки за собівартістю (BR-RPT-034)' })
  totalCostValue!: number;
  @ApiProperty({ description: 'Σ saleValue — залишки за цінами продажу' })
  totalSaleValue!: number;
}

// ─── /reports/profitability ──────────────────────────────────────────────────

export class ProfitabilityReportDto {
  @ApiProperty({ description: 'Виручка БЕЗ ПДВ — база прибутку й маржі' }) totalRevenue!: number;
  @ApiProperty({ description: 'ПДВ у виручці' }) totalVat!: number;
  @ApiProperty({ description: 'Виручка З ПДВ' }) totalRevenueWithVat!: number;
  @ApiProperty({ description: 'Собівартість = запчастини + роботи' }) totalCost!: number;
  @ApiProperty() totalCostParts!: number;
  @ApiProperty({ description: 'Роботи без ПДВ × laborCostRatio' }) totalCostLabor!: number;
  @ApiProperty({ description: 'Виручка − собівартість' }) grossProfit!: number;
  @ApiProperty({ description: 'ВІДСОТОК (не гроші): grossProfit / totalRevenue × 100' })
  margin!: number;
  @ApiProperty() ordersCount!: number;
  @ApiProperty({ description: 'Скільки запчастин без відомої закупівельної ціни' })
  unknownCostPartsCount!: number;
  @ApiProperty({
    description:
      'Частка праці в собівартості робіт, 0…1 (OrganisationSettings.laborCostRatio, BR-RPT-035)',
    example: 0.4,
  })
  laborCostRatio!: number;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}

// ─── /reports/pnl (BR-RPT-030) ───────────────────────────────────────────────

export const PNL_ROW_KEYS = [
  'revenue',
  'partsCost',
  'grossProfit',
  'payroll',
  'expenses',
  'expenseCategory',
  'otherIncome',
  'incomeCategory',
  'fx',
  'netProfit',
] as const;
export type PnlRowKey = (typeof PNL_ROW_KEYS)[number];

export class PnlRowDto {
  @ApiProperty({
    enum: PNL_ROW_KEYS,
    enumName: 'PnlRowKey',
    description:
      'Рядок звіту: виручка, запчастини, валовий прибуток, зарплата, операційні витрати (і рядки ' +
      'статей expenseCategory), інші доходи (incomeCategory), курсові різниці, чистий прибуток',
  })
  key!: PnlRowKey;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Назва статті (лише рядки статей); null — «без статті»',
  })
  label?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Стаття; null — без статті' })
  categoryId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Батьківська стаття' })
  parentId?: string | null;
  @ApiPropertyOptional({ description: 'Рівень статті в дереві (0 — корінь)' })
  depth?: number;
  @ApiProperty({ type: [Number], description: 'Суми по місяцях (порядок — months)' })
  amounts!: number[];
  @ApiProperty({ description: 'Разом за період' }) total!: number;
}

/** Налаштування організації, за якими пораховано P&L (BR-RPT-030, пп. 4–6). */
export class PnlSettingsDto {
  @ApiProperty({
    enum: PNL_INCOME_CASH_REASON_OPTIONS,
    isArray: true,
    description: 'Приводи касових надходжень зі статтею INCOME, що увійшли в «інші доходи»',
  })
  incomeCashReasons!: CashReasonValue[];
  @ApiProperty({
    enum: PNL_EXPENSE_CASH_REASON_OPTIONS,
    isArray: true,
    description: 'Приводи касових видач, що увійшли у витрати (EXPENSE — завжди)',
  })
  expenseCashReasons!: CashReasonValue[];
  @ApiProperty({ description: 'Попередження про зарплату — і для місяців, що ще не почалися' })
  warnFuturePayroll!: boolean;
  @ApiProperty({
    description:
      'Повернення підзвіту зменшує витрату статті (діє лише тоді, коли «Під звіт» серед витрат)',
  })
  netAdvanceReturns!: boolean;
}

export class PnlReportDto {
  @ApiProperty({ type: [String], example: ['2026-09', '2026-10'], description: 'Місяці YYYY-MM' })
  months!: string[];
  @ApiProperty({ type: [PnlRowDto] }) rows!: PnlRowDto[];
  @ApiProperty({ description: 'Скільки запчастин без відомої закупівельної ціни' })
  unknownCostPartsCount!: number;
  @ApiProperty({
    type: [String],
    description: 'Місяці (YYYY-MM), за які зарплату не розраховано — прибуток там завищений',
  })
  payrollMissingMonths!: string[];
  @ApiProperty({ type: PnlSettingsDto }) settings!: PnlSettingsDto;
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
  @ApiProperty({
    description: 'Кількість слотів за період; 0 — підйомник без жодного запису (теж у звіті)',
  })
  totalSlots!: number;
  @ApiProperty({ description: 'Σ годин зайнятості' }) totalHours!: number;
  @ApiProperty({
    description:
      'Місткість, год: робочі дні філії підйомника за період × тривалість робочого дня ' +
      '(BranchSettings; без них — 09:00–18:00, пн–пт), BR-RPT-033',
  })
  capacityHours!: number;
  @ApiProperty({
    description:
      'ВІДСОТОК завантаження = totalHours / capacityHours, один знак після коми (може ' +
      'перевищувати 100); місткість 0 → 0',
  })
  loadPercent!: number;
}

export class LoadReportDto {
  @ApiProperty({ type: [LoadReportRowDto] }) rows!: LoadReportRowDto[];
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ description: 'Календарних днів у періоді (мінімум 1)' })
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
