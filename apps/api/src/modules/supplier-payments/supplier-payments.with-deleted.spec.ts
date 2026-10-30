/**
 * SupplierPaymentsService — оплата, позначена на видалення: лише перегляд (BR-WO-012)
 *
 * `findOne(..., { withDeleted: true })` показує видалену оплату; кожна змінна операція
 * шукає документ серед невидалених і дає 404. HTTP-частину (query-параметр) перевіряє
 * supplier-payments.contract.spec.ts.
 */
import { describeDeletedDocument } from '../../common/testing/deleted-document';
import { SupplierPaymentsService } from './supplier-payments.service';

// guards: BR-WO-012
describeDeletedDocument<SupplierPaymentsService>({
  title: 'SupplierPaymentsService — документ, позначений на видалення (BR-WO-012)',
  service: SupplierPaymentsService,
  model: 'supplierPayment',
  row: {
    number: 'ОП-20261012-000001',
    status: 'DRAFT',
    supplierId: '22222222-2222-4222-8222-222222222222',
    sourceType: 'BANK_ACCOUNT',
    bankAccountId: '55555555-5555-4555-8555-555555555555',
    cashRegisterId: null,
    purchaseOrderId: null,
    currencyId: null,
    amount: 500,
    amountBase: null,
    rateUsed: null,
    notes: null,
    paymentDate: new Date('2026-10-12'),
    documentDate: new Date('2026-10-12'),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    updatedAt: new Date('2026-10-12T09:30:00Z'),
    supplier: { firstName: null, lastName: null, companyName: 'Acme' },
    bankAccount: { name: 'Основний рахунок' },
    cashRegister: null,
    purchaseOrder: null,
    currency: null,
  },
  findOne: (svc, orgId, id, opts) => svc.findOne(orgId, id, opts),
  mutations: {
    confirm: (svc, orgId, id) => svc.confirm(orgId, id, 'user-1'),
    cancel: (svc, orgId, id) => svc.cancel(orgId, id),
    'remove (повторне видалення)': (svc, orgId, id) => svc.remove(orgId, id),
  },
});
