/**
 * InvoicesService — рахунок, позначений на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., { withDeleted: true })` показує видалений рахунок; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * invoices.contract.spec.ts.
 */
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { InvoicesService } from './invoices.service';

const LINE_ID = '77777777-7777-4777-8777-777777777777';

// guards: BR-WO-012
describeDeletedDocument<InvoicesService>({
  title: 'InvoicesService — документ, позначений на видалення (BR-WO-012)',
  service: InvoicesService,
  model: 'invoice',
  row: {
    number: 'РФ-20261012-000001',
    status: 'DRAFT',
    counterpartyId: '22222222-2222-4222-8222-222222222222',
    workOrderId: null,
    amount: 120,
    paidAmount: 0,
    totalWithoutVat: 100,
    totalVat: 20,
    totalWithVat: 120,
    currencyId: null,
    totalAmountBase: null,
    rateUsed: null,
    currency: null,
    invoiceType: 'STANDARD',
    notes: null,
    dueDate: null,
    documentDate: new Date('2026-10-12'),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ Клієнт' },
    workOrder: null,
    payments: [],
    lines: [],
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, opts),
  mutations: {
    update: (svc, orgId, id) => svc.update(orgId, id, { notes: 'нове' }),
    'transition → SENT': (svc, orgId, id) => svc.transition(orgId, id, 'SENT', 'user-1'),
    'transition → PAID': (svc, orgId, id) => svc.transition(orgId, id, 'PAID', 'user-1'),
    clone: (svc, orgId, id) => svc.clone(orgId, id),
    addLine: (svc, orgId, id) =>
      svc.addLine(orgId, id, { description: 'Послуга', quantity: 1, unitPrice: 100 }),
    updateLine: (svc, orgId, id) => svc.updateLine(orgId, id, LINE_ID, { quantity: 2 }),
    removeLine: (svc, orgId, id) => svc.removeLine(orgId, id, LINE_ID),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id),
  },
});
