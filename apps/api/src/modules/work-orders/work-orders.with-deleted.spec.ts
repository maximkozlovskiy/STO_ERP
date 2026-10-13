/**
 * WorkOrdersService — наряд, позначений на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., role, { withDeleted: true })` показує видалений наряд; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * work-orders.contract.spec.ts.
 */
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { WorkOrdersService } from './work-orders.service';

const LINE_ID = '77777777-7777-4777-8777-777777777777';
const PART_ID = '88888888-8888-4888-8888-888888888888';
const GOOD_ID = '44444444-4444-4444-8444-444444444444';
const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
const WORK_ID = '55555555-5555-4555-8555-555555555555';
const EMPLOYEE_ID = '66666666-6666-4666-8666-666666666666';

// guards: BR-WO-012
describeDeletedDocument<WorkOrdersService>({
  title: 'WorkOrdersService — документ, позначений на видалення (BR-WO-012)',
  service: WorkOrdersService,
  model: 'workOrder',
  row: {
    number: 'НЗ-20261012-000001',
    status: 'DRAFT',
    priority: 'NORMAL',
    repairCategory: null,
    branchId: 'b-1',
    branch: { name: 'Головна' },
    vehicleId: 'v-1',
    vehicle: { make: 'Skoda', model: 'Octavia', licensePlate: 'AA1234BB' },
    counterpartyId: 'c-1',
    counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
    contractId: null,
    contract: null,
    currencyId: null,
    currency: null,
    liftId: null,
    lift: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    plannedHours: null,
    actualHours: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 0,
    totalActualLabor: 0,
    totalParts: 0,
    totalAmount: 0,
    paidAmount: 0,
    documentDate: new Date('2026-10-12'),
    syncVersion: 0n,
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    lines: [],
    parts: [],
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, 'OWNER', opts),
  mutations: {
    update: (svc, orgId, id) => svc.update(orgId, id, { description: 'нове' }, 'user-1'),
    clone: (svc, orgId, id) => svc.clone(orgId, id, 'user-1'),
    'transition → IN_PROGRESS': (svc, orgId, id) =>
      svc.transition(orgId, id, 'IN_PROGRESS', 'user-1'),
    'transition → CANCELLED': (svc, orgId, id) => svc.transition(orgId, id, 'CANCELLED', 'user-1'),
    addLine: (svc, orgId, id) =>
      svc.addLine(orgId, id, {
        workId: WORK_ID,
        employeeId: EMPLOYEE_ID,
        normoHours: 1,
        price: 500,
      }),
    updateLine: (svc, orgId, id) => svc.updateLine(orgId, id, LINE_ID, { normoHours: 2 }),
    removeLine: (svc, orgId, id) => svc.removeLine(orgId, id, LINE_ID),
    addPart: (svc, orgId, id) =>
      svc.addPart(
        orgId,
        id,
        { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1, price: 100 },
        'OWNER',
      ),
    updatePart: (svc, orgId, id) => svc.updatePart(orgId, id, PART_ID, { quantity: 2 }, 'OWNER'),
    removePart: (svc, orgId, id) => svc.removePart(orgId, id, PART_ID),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id, 'user-1'),
  },
});
