/**
 * SupplierReturnsService — повернення, позначене на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., { withDeleted: true })` показує видалене повернення; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * supplier-returns.contract.spec.ts.
 */
import { SupplierReturnStatus } from '@prisma/client';
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { SupplierReturnsService } from './supplier-returns.service';

const GOOD_ID = '44444444-4444-4444-8444-444444444444';

// guards: BR-WO-012
describeDeletedDocument<SupplierReturnsService>({
  title: 'SupplierReturnsService — документ, позначений на видалення (BR-WO-012)',
  service: SupplierReturnsService,
  model: 'supplierReturn',
  row: {
    number: 'ПВП-20261012-000001',
    status: SupplierReturnStatus.DRAFT,
    supplierId: '22222222-2222-4222-8222-222222222222',
    warehouseId: '33333333-3333-4333-8333-333333333333',
    purchaseOrderId: null,
    totalAmount: 60,
    notes: null,
    documentDate: new Date('2026-10-12'),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    supplier: { firstName: null, lastName: null, companyName: 'Acme' },
    warehouse: { name: 'Склад 1' },
    purchaseOrder: null,
    lines: [],
    _count: { lines: 1 },
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, opts),
  mutations: {
    'update (примітка)': (svc, orgId, id) => svc.update(orgId, id, { notes: 'нове' }),
    'update (рядки)': (svc, orgId, id) =>
      svc.update(orgId, id, { lines: [{ goodId: GOOD_ID, quantity: 1, price: 10 }] }),
    confirm: (svc, orgId, id) => svc.confirm(orgId, id, 'user-1'),
    cancel: (svc, orgId, id) => svc.cancel(orgId, id),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id),
  },
});
