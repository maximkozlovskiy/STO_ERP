import { ApiProperty } from '@nestjs/swagger';

export const LINES_SUMMARY_TABLE_KEYS = ['works', 'goods', 'other'] as const;
export type LinesSummaryTableKey = (typeof LINES_SUMMARY_TABLE_KEYS)[number];

export const LINES_SUMMARY_QUANTITY_UNITS = ['hours', 'units'] as const;
export type LinesSummaryQuantityUnit = (typeof LINES_SUMMARY_QUANTITY_UNITS)[number];

/** Зведення однієї табличної частини документа. */
export class LinesSummaryTableDto {
  @ApiProperty({ enum: LINES_SUMMARY_TABLE_KEYS, description: 'Яка таблиця: роботи, товари, інше' })
  key!: LinesSummaryTableKey;

  @ApiProperty({ description: 'Кількість рядків таблиці' })
  positions!: number;

  @ApiProperty({
    description:
      'Кількість РІЗНИХ найменувань (товарів / робіт); для «іншого» — те саме, що рядків',
  })
  distinct!: number;

  @ApiProperty({ description: 'Сума по рядках: кількість або нормо-години (див. quantityUnit)' })
  quantity!: number;

  @ApiProperty({
    enum: LINES_SUMMARY_QUANTITY_UNITS,
    description: 'hours — нормо-години (роботи наряду); units — кількість у рядках',
  })
  quantityUnit!: LinesSummaryQuantityUnit;
}

/** Виконавець із рядків робіт наряду. */
export class LinesSummaryExecutorDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty({ description: 'Прізвище Ім’я; порожній рядок, якщо картку працівника не знайдено' })
  name!: string;
  @ApiProperty({ description: 'Скільки рядків робіт на цьому виконавцеві' })
  works!: number;
  @ApiProperty({ description: 'Сума нормо-годин його рядків' })
  normoHours!: number;
}

/** GET /<документ>/:id/lines-summary — зведення по табличних частинах (BR-WO-009). */
export class LinesSummaryDto {
  @ApiProperty({ type: [LinesSummaryTableDto], description: 'Лише непорожні таблиці' })
  tables!: LinesSummaryTableDto[];

  @ApiProperty({
    type: [LinesSummaryExecutorDto],
    description: 'Виконавці з рядків робіт; порожньо для документів без виконавців у рядках',
  })
  executors!: LinesSummaryExecutorDto[];
}
