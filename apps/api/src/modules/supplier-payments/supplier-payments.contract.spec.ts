import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierPaymentsController } from './supplier-payments.controller';
import type { SupplierPaymentScheduleDocumentsQueryDto } from './supplier-payments.dto';

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
