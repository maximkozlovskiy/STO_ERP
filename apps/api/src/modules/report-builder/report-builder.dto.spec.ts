/**
 * Межі config звіту на вході API (BR-RPT-016): class-validator на ReportConfigDto.
 * HTTP-шар тут не піднімається — перевіряємо саме декоратори DTO.
 */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReportConfigDto } from './report-builder.dto';

const GROUPABLE = ['status', 'priority', 'counterparty.type', 'counterparty.companyName'];

/** Імена властивостей, на яких валідатор знайшов помилку. */
const invalidProps = (plain: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(ReportConfigDto, plain)).map(e => e.property);

describe('ReportConfigDto — межі config', () => {
  // guards: BR-RPT-016
  it('groupBy: 5 рівнів проходить, 6 — помилка валідації з ключем err.dto.reportBuilder.groupBy.max', () => {
    const five = [...GROUPABLE, 'branch.name'];
    expect(invalidProps({ entity: 'workOrder', columns: [], groupBy: five })).toEqual([]);

    const errors = validateSync(
      plainToInstance(ReportConfigDto, {
        entity: 'workOrder',
        columns: [],
        groupBy: [...five, 'number'],
      }),
    );
    expect(errors.map(e => e.property)).toEqual(['groupBy']);
    expect(Object.values(errors[0].constraints ?? {})).toEqual([
      'err.dto.reportBuilder.groupBy.max',
    ]);
  });
});
