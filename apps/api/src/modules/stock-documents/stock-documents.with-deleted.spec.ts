/**
 * StockDocumentsService — складський документ, позначений на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., { withDeleted: true })` показує видалений документ; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * stock-documents.contract.spec.ts.
 */
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { StockDocumentsService } from './stock-documents.service';

// guards: BR-WO-012
describeDeletedDocument<StockDocumentsService>({
  title: 'StockDocumentsService — документ, позначений на видалення (BR-WO-012)',
  service: StockDocumentsService,
  model: 'stockDocument',
  row: {
    number: 'ПН-20261012-000001',
    type: 'RECEIPT',
    status: 'DRAFT',
    branchId: null,
    warehouseId: '33333333-3333-4333-8333-333333333333',
    targetWarehouseId: null,
    purchaseOrderId: null,
    notes: null,
    documentDate: new Date('2026-10-12'),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    branch: null,
    warehouse: { name: 'Склад 1' },
    targetWarehouse: null,
    purchaseOrder: null,
    lines: [],
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, opts),
  mutations: {
    update: (svc, orgId, id) => svc.update(orgId, id, { notes: 'нове' }),
    'transition → CONFIRMED': (svc, orgId, id) => svc.transition(orgId, id, 'CONFIRMED', 'user-1'),
    'transition → CANCELLED': (svc, orgId, id) => svc.transition(orgId, id, 'CANCELLED', 'user-1'),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id),
  },
});
