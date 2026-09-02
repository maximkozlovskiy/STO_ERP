import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SupplierPaymentsController } from './supplier-payments.controller';
import {
  SupplierPaymentScheduleDocumentsQueryDto,
  SupplierPaymentScheduleQueryDto,
} from './supplier-payments.dto';

/**
 * Contract-тест drill-down endpoint GET schedule/documents.
 * Захищає date XOR target guard у контролері (кастомна логіка поза DTO-декораторами):
 * рівно одне з date/target має бути задане, інакше 400. Regression проти повернення
 * до стану коли обидва/жодного тихо проходять.
 */
describe('SupplierPaymentsController — schedule/documents contract', () => {
  let controller: SupplierPaymentsController;
  let service: { getScheduleDocuments: ReturnType<typeof vi.fn> };
  const ORG = 'org-1';

  beforeEach(() => {
    service = { getScheduleDocuments: vi.fn().mockResolvedValue([]) };
    controller = new SupplierPaymentsController(service as never);
  });

  const q = (over: Partial<SupplierPaymentScheduleDocumentsQueryDto>) =>
    ({ from: '2026-09-02', to: '2026-09-21', ...over }) as SupplierPaymentScheduleDocumentsQueryDto;

  // Bug #616 regression-guard: semantically-invalid `date` (shape passes regex,
  // parse fails) → validation error. Дзеркалить існуючий контракт для `from`/`to`
  // у `SupplierPaymentScheduleQueryDto` (Bug #595).
  describe('Bug #616 — DTO validation for `date` catches semantic-invalid dates', () => {
    it.each(['2026-99-99', '2026-13-01', '2026-02-31', '9999-99-99'])(
      'date=%s → validation error (не пропускається у сервіс)',
      async badDate => {
        const dto = plainToInstance(SupplierPaymentScheduleDocumentsQueryDto, {
          from: '2026-09-02',
          to: '2026-09-21',
          date: badDate,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.property === 'date')).toBe(true);
      },
    );

    it('date=2026-09-08 (valid) → no validation errors', async () => {
      const dto = plainToInstance(SupplierPaymentScheduleDocumentsQueryDto, {
        from: '2026-09-02',
        to: '2026-09-21',
        date: '2026-09-08',
      });
      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'date')).toEqual([]);
    });

    // Symmetric guard: паттерн для `from`/`to` вже покритий; підтверджуємо що обидва
    // DTO мають однакову семантику (не регресія в one but not the other).
    it('`from` у SupplierPaymentScheduleQueryDto — теж ловить semantic-invalid дату', async () => {
      const dto = plainToInstance(SupplierPaymentScheduleQueryDto, {
        from: '2026-99-99',
        to: '2026-09-21',
      });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'from')).toBe(true);
    });
  });

  it('date задано → делегує з target {kind:date}', () => {
    controller.getScheduleDocuments(ORG, q({ date: '2026-09-08', supplierId: 'sup-1' }));
    expect(service.getScheduleDocuments).toHaveBeenCalledWith(
      ORG,
      '2026-09-02',
      '2026-09-21',
      { kind: 'date', date: '2026-09-08' },
      'sup-1',
    );
  });

  it('target=overdue → делегує з {kind:overdue}', () => {
    controller.getScheduleDocuments(ORG, q({ target: 'overdue' }));
    expect(service.getScheduleDocuments).toHaveBeenCalledWith(
      ORG,
      '2026-09-02',
      '2026-09-21',
      { kind: 'overdue' },
      undefined,
    );
  });

  it('date + target разом → BadRequestException (взаємовиключні)', () => {
    expect(() =>
      controller.getScheduleDocuments(ORG, q({ date: '2026-09-08', target: 'overdue' })),
    ).toThrow(BadRequestException);
    expect(service.getScheduleDocuments).not.toHaveBeenCalled();
  });

  it('ні date, ні target → BadRequestException', () => {
    expect(() => controller.getScheduleDocuments(ORG, q({}))).toThrow(BadRequestException);
    expect(service.getScheduleDocuments).not.toHaveBeenCalled();
  });
});
