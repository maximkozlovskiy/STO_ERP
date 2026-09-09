import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkOrderEventHandlers } from './work-order.handlers';
import { WorkOrderCompletedEvent, WorkOrderTransitionedEvent } from './work-order.events';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { MaintenanceSchedulesService } from '../../maintenance-schedules/maintenance-schedules.service';
import type { WarrantiesService } from '../../warranties/warranties.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { SettingsService } from '../../settings/settings.service';
import type { AuditService } from '../../audit/audit.service';

/**
 * A2: @OnEvent-хендлери lifecycle-side-effects. Кожен best-effort (помилка не прокидається) і гейтить
 * свою умову (COMPLETED-контекст, MAINTENANCE, warrantyDays>0, userId).
 */
describe('WorkOrderEventHandlers', () => {
  const vehicleUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const updateAfterWorkOrder = vi.fn().mockResolvedValue(undefined);
  const autoCreate = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const getOrganisationSettings = vi.fn().mockResolvedValue({ defaultWarrantyDays: 30 });
  const record = vi.fn().mockResolvedValue(undefined);

  const prisma = { vehicle: { updateMany: vehicleUpdateMany } } as unknown as PrismaService;
  const maintenance = { updateAfterWorkOrder } as unknown as MaintenanceSchedulesService;
  const warranties = { autoCreate } as unknown as WarrantiesService;
  const notifications = { send } as unknown as NotificationsService;
  const settings = { getOrganisationSettings } as unknown as SettingsService;
  const audit = { record } as unknown as AuditService;

  let handlers: WorkOrderEventHandlers;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new WorkOrderEventHandlers(
      prisma,
      maintenance,
      warranties,
      notifications,
      settings,
      audit,
    );
  });

  // 'k' in over — щоб явний null/0 у override НЕ підмінявся дефолтом (?? з'їв би їх).
  const pick = <K extends keyof WorkOrderCompletedEvent>(
    over: Partial<WorkOrderCompletedEvent>,
    k: K,
    def: WorkOrderCompletedEvent[K],
  ): WorkOrderCompletedEvent[K] => (k in over ? (over[k] as WorkOrderCompletedEvent[K]) : def);

  const completed = (over: Partial<WorkOrderCompletedEvent> = {}) =>
    new WorkOrderCompletedEvent(
      pick(over, 'orgId', 'o1'),
      pick(over, 'workOrderId', 'wo1'),
      pick(over, 'vehicleId', 'v1'),
      pick(over, 'completedAt', new Date('2026-01-01')),
      pick(over, 'repairCategory', 'MAINTENANCE'),
      pick(over, 'outMileage', 12000),
      pick(over, 'workOrderNumber', 'WO-1'),
      pick(over, 'branchId', 'br1'),
      pick(over, 'counterparty', {
        phone: '+380671112233',
        email: null,
        firstName: 'Іван',
        lastName: 'Петренко',
        companyName: null,
      }),
    );

  // ── аудит переходу ──
  it('onTransitioned з userId → audit.record(from→to)', async () => {
    await handlers.onTransitioned(
      new WorkOrderTransitionedEvent('o1', 'wo1', 'APPROVED', 'IN_PROGRESS', 'u1'),
    );
    expect(record).toHaveBeenCalledWith(
      'o1',
      'WorkOrder',
      'wo1',
      'UPDATE',
      'u1',
      { status: 'APPROVED' },
      { status: 'IN_PROGRESS' },
    );
  });

  it('onTransitioned БЕЗ userId (системний) → audit пропускається', async () => {
    await handlers.onTransitioned(
      new WorkOrderTransitionedEvent('o1', 'wo1', 'APPROVED', 'IN_PROGRESS', undefined),
    );
    expect(record).not.toHaveBeenCalled();
  });

  // ── пробіг ──
  it('syncMileage оновлює currentMileage (lt або NULL)', async () => {
    await handlers.syncMileage(completed({ outMileage: 12000 }));
    expect(vehicleUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'v1',
        orgId: 'o1',
        OR: [{ currentMileage: null }, { currentMileage: { lt: 12000 } }],
      },
      data: { currentMileage: 12000 },
    });
  });

  it('syncMileage без outMileage → no-op', async () => {
    await handlers.syncMileage(completed({ outMileage: null }));
    expect(vehicleUpdateMany).not.toHaveBeenCalled();
  });

  // ── ТО ──
  it('updateMaintenance для MAINTENANCE → викликає updateAfterWorkOrder', async () => {
    await handlers.updateMaintenance(completed({ repairCategory: 'MAINTENANCE' }));
    expect(updateAfterWorkOrder).toHaveBeenCalledWith('o1', 'v1', new Date('2026-01-01'), 12000);
  });

  it('updateMaintenance для не-MAINTENANCE (null) → no-op', async () => {
    await handlers.updateMaintenance(completed({ repairCategory: null }));
    expect(updateAfterWorkOrder).not.toHaveBeenCalled();
  });

  // ── гарантія ──
  it('createWarranty з warrantyDays>0 → autoCreate', async () => {
    getOrganisationSettings.mockResolvedValueOnce({ defaultWarrantyDays: 30 });
    await handlers.createWarranty(completed());
    expect(autoCreate).toHaveBeenCalledWith('o1', 'wo1', 30);
  });

  it('createWarranty з warrantyDays=0 → без autoCreate', async () => {
    getOrganisationSettings.mockResolvedValueOnce({ defaultWarrantyDays: 0 });
    await handlers.createWarranty(completed());
    expect(autoCreate).not.toHaveBeenCalled();
  });

  // ── нотифікація ──
  it('notify → notifications.send WO_COMPLETED з clientName', async () => {
    await handlers.notify(completed());
    expect(send).toHaveBeenCalledWith(
      'o1',
      'WO_COMPLETED',
      expect.objectContaining({ workOrderNumber: 'WO-1', branchId: 'br1', phone: '+380671112233' }),
    );
  });

  // ── best-effort: помилка не прокидається ──
  it('помилка side-effect не прокидається (best-effort)', async () => {
    autoCreate.mockRejectedValueOnce(new Error('DB down'));
    await expect(handlers.createWarranty(completed())).resolves.toBeUndefined();
    send.mockRejectedValueOnce(new Error('queue down'));
    await expect(handlers.notify(completed())).resolves.toBeUndefined();
  });
});
