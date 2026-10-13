/**
 * PurchaseOrdersService — замовлення, позначене на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., { withDeleted: true })` показує видалене замовлення; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * purchase-orders.contract.spec.ts.
 */
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { PurchaseOrdersService } from './purchase-orders.service';

const LINE_ID = '77777777-7777-4777-8777-777777777777';

// guards: BR-WO-012
describeDeletedDocument<PurchaseOrdersService>({
  title: 'PurchaseOrdersService — документ, позначений на видалення (BR-WO-012)',
  service: PurchaseOrdersService,
  model: 'purchaseOrder',
  row: {
    number: 'ЗП-20261012-000001',
    status: 'DRAFT',
    supplierId: '22222222-2222-4222-8222-222222222222',
    warehouseId: '33333333-3333-4333-8333-333333333333',
    contractId: null,
    currencyId: null,
    totalAmount: 100,
    paidAmount: 0,
    notes: null,
    expectedAt: null,
    documentDate: new Date('2026-10-12'),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    supplier: { firstName: null, lastName: null, companyName: 'Acme' },
    warehouse: { name: 'Склад 1' },
    contract: null,
    currency: null,
    lines: [],
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, opts),
  mutations: {
    update: (svc, orgId, id) => svc.update(orgId, id, { notes: 'нове' }),
    'transition → ORDERED': (svc, orgId, id) => svc.transition(orgId, id, 'ORDERED'),
    'transition → CANCELLED': (svc, orgId, id) => svc.transition(orgId, id, 'CANCELLED'),
    receive: (svc, orgId, id) =>
      svc.receive(orgId, id, { lines: [{ lineId: LINE_ID, receivedQty: 1 }] }, 'user-1'),
    applyPricing: (svc, orgId, id) => svc.applyPricing(orgId, id),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id),
  },
});
