/**
 * Збережені звіти (SavedReport) і tenant-межа запуску: що саме сервіс передає у Prisma.
 * Prisma — стаб; SQL тут не виконується, перевіряється форма запитів.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReportBuilderService } from './report-builder.service';
import type { FullReportConfig } from './report-builder.service';

const ORG = 'org-caller';
const ID = '11111111-1111-4111-8111-111111111111';

const validConfig = (): FullReportConfig => ({
  entity: 'invoice',
  columns: ['number', 'amount'],
  groupBy: [],
});

/** Factory, не const: `isolate: false` без clearMocks — моки не діляться між кейсами. */
function setup(stored: Record<string, unknown> | null = { id: ID, config: validConfig() }) {
  const savedReport = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(stored),
    create: vi.fn().mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data)),
    update: vi.fn().mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data)),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  const invoice = { findMany: vi.fn().mockResolvedValue([]) };
  const service = new ReportBuilderService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { savedReport, invoice } as any,
  );
  return { service, savedReport, invoice };
}

describe('ReportBuilderService — збережені звіти', () => {
  // guards: BR-RPT-017
  it('listSaved: лише свої (orgId) і не видалені, без фільтра за автором', async () => {
    const { service, savedReport } = setup();
    await service.listSaved(ORG);
    expect(savedReport.findMany).toHaveBeenCalledTimes(1);
    expect(savedReport.findMany.mock.calls[0][0].where).toEqual({ orgId: ORG, deletedAt: null });
  });

  // guards: BR-RPT-017
  it('getSaved шукає за id + orgId + deletedAt:null; не знайдено → NotFoundException', async () => {
    const { service, savedReport } = setup(null);
    await expect(service.getSaved(ORG, ID)).rejects.toThrow(NotFoundException);
    expect(savedReport.findFirst.mock.calls[0][0].where).toEqual({
      id: ID,
      orgId: ORG,
      deletedAt: null,
    });
  });

  // guards: BR-RPT-017
  it('updateSaved / removeSaved / runSaved чужого або видаленого звіту → NotFoundException, запису й запуску немає', async () => {
    const { service, savedReport, invoice } = setup(null);
    await expect(service.updateSaved(ORG, ID, { name: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.removeSaved(ORG, ID)).rejects.toThrow(NotFoundException);
    await expect(service.runSaved(ORG, ID)).rejects.toThrow(NotFoundException);
    expect(savedReport.update).not.toHaveBeenCalled();
    expect(savedReport.updateMany).not.toHaveBeenCalled();
    expect(invoice.findMany).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-017
  it('updateSaved: where оновлення несе id + orgId + deletedAt:null', async () => {
    const { service, savedReport } = setup();
    await service.updateSaved(ORG, ID, { name: 'Нова назва' });
    expect(savedReport.update.mock.calls[0][0].where).toEqual({
      id: ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(savedReport.update.mock.calls[0][0].data).toEqual({ name: 'Нова назва' });
  });

  // guards: BR-RPT-017
  it('createSaved пише orgId викликача, entity з config і автора у createdBy', async () => {
    const { service, savedReport } = setup();
    await service.createSaved(ORG, { name: 'Рахунки', config: validConfig() }, 'user-7');
    expect(savedReport.create.mock.calls[0][0].data).toEqual({
      orgId: ORG,
      name: 'Рахунки',
      entity: 'invoice',
      config: validConfig(),
      createdBy: 'user-7',
    });
  });

  // guards: BR-RPT-018
  it('createSaved з невалідним config → BadRequestException, запис не створюється', async () => {
    const { service, savedReport } = setup();
    const bad = { ...validConfig(), columns: ['secretField'] };
    await expect(service.createSaved(ORG, { name: 'x', config: bad }, 'u')).rejects.toThrow(
      BadRequestException,
    );
    expect(savedReport.create).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-018
  it('updateSaved з невалідним config → BadRequestException, оновлення не виконується', async () => {
    const { service, savedReport } = setup();
    const bad = { ...validConfig(), filters: [{ field: 'status', op: 'eq' as const, value: 'X' }] };
    await expect(service.updateSaved(ORG, ID, { config: bad })).rejects.toThrow(
      BadRequestException,
    );
    expect(savedReport.update).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-019
  it('removeSaved — soft delete: updateMany з deletedAt, фізичного delete немає', async () => {
    const { service, savedReport } = setup();
    await service.removeSaved(ORG, ID);
    expect(savedReport.updateMany).toHaveBeenCalledTimes(1);
    const arg = savedReport.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: ID, orgId: ORG, deletedAt: null });
    expect(Object.keys(arg.data)).toEqual(['deletedAt']);
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
    expect(savedReport.delete).not.toHaveBeenCalled();
    expect(savedReport.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ReportBuilderService — tenant-межа запуску', () => {
  // guards: BR-RPT-006
  it('run: findMany моделі з реєстру отримує where.orgId викликача і take-ліміт', async () => {
    const { service, invoice } = setup();
    await service.run(ORG, validConfig());
    expect(invoice.findMany).toHaveBeenCalledTimes(1);
    const args = invoice.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ orgId: ORG, deletedAt: null });
    expect(args.take).toBe(5000);
  });

  // guards: BR-RPT-006
  it('runSaved: orgId береться від викликача, а не зі збереженого config', async () => {
    const poisoned = { ...validConfig(), orgId: 'org-other', where: { orgId: 'org-other' } };
    const { service, invoice } = setup({ id: ID, orgId: ORG, config: poisoned });
    await service.runSaved(ORG, ID);
    expect(invoice.findMany.mock.calls[0][0].where).toEqual({ orgId: ORG, deletedAt: null });
  });
});
