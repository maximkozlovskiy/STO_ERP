import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable } from '../../cash/cash.spec-fixture';
import type { DeadLetterService } from '../../dead-letter/dead-letter.service';
import type { SettingsService } from '../../settings/settings.service';
import type { SupplierConnectionsService } from '../connections/supplier-connections.service';
import type { SupplierOffersService } from '../offers/supplier-offers.service';
import type { SupplierOrdersService } from '../orders/supplier-orders.service';
import { ORG } from '../supplier-api.spec-fixture';
import { SupplierMaintenanceProcessor } from './supplier-maintenance.processor';

/**
 * `sweep` (BR-SCON-006, BR-SOFR-003): загублені в черзі рядки ставляться знову, пропозиції
 * старші за `supplierOfferRetentionDays` — soft delete. Таблиці в пам'яті виконують `where`.
 */
const ago = (ms: number) => new Date(Date.now() - ms);
const DAY = 86_400_000;

function setup() {
  const tables = {
    supplierOfferRequest: memoryTable([
      { id: 'stuck', orgId: ORG, status: 'QUEUED', deletedAt: null, createdAt: ago(5 * 60_000) },
      { id: 'fresh', orgId: ORG, status: 'QUEUED', deletedAt: null, createdAt: ago(10_000) },
      { id: 'old-done', orgId: ORG, status: 'DONE', deletedAt: null, createdAt: ago(10 * DAY) },
      {
        id: 'other-org',
        orgId: 'other',
        status: 'QUEUED',
        deletedAt: null,
        createdAt: ago(5 * 60_000),
      },
    ]),
    supplierConnection: memoryTable([
      {
        id: 'c-pending',
        orgId: ORG,
        verifyStatus: 'PENDING',
        verifyRequestedAt: ago(3 * 60_000),
        deletedAt: null,
      },
      {
        id: 'c-ok',
        orgId: ORG,
        verifyStatus: 'OK',
        verifyRequestedAt: ago(3 * 60_000),
        deletedAt: null,
      },
    ]),
    purchaseOrder: memoryTable([
      {
        id: 'po-q',
        orgId: ORG,
        supplierApiStatus: 'QUEUED',
        deletedAt: null,
        updatedAt: ago(3 * 60_000),
      },
      {
        id: 'po-sent',
        orgId: ORG,
        supplierApiStatus: 'SENT',
        deletedAt: null,
        updatedAt: ago(3 * 60_000),
      },
    ]),
    supplierOffer: memoryTable([
      { id: 'o-old', orgId: ORG, deletedAt: null, fetchedAt: ago(8 * DAY) },
      { id: 'o-new', orgId: ORG, deletedAt: null, fetchedAt: ago(DAY) },
    ]),
  };
  const offers = { enqueueSearch: vi.fn(() => Promise.resolve(true)) };
  const connections = { enqueueVerify: vi.fn(() => Promise.resolve(true)) };
  const orders = { enqueuePlace: vi.fn(() => Promise.resolve(true)) };
  const settings = {
    getOrganisationSettings: vi.fn(() => Promise.resolve({ supplierOfferRetentionDays: 7 })),
  };
  const proc = new SupplierMaintenanceProcessor(
    tables as unknown as PrismaService,
    settings as unknown as SettingsService,
    connections as unknown as SupplierConnectionsService,
    offers as unknown as SupplierOffersService,
    orders as unknown as SupplierOrdersService,
    {} as DeadLetterService,
  );
  return { proc, tables, offers, connections, orders };
}

describe('supplier-maintenance sweep', () => {
  // guards: BR-SCON-006
  it('загублені QUEUED-пошуки, PENDING-перевірки й QUEUED-замовлення — знову в чергу (лише свої й старші 2 хв)', async () => {
    const { proc, offers, connections, orders } = setup();
    await proc.sweepOrg(ORG);
    expect(offers.enqueueSearch.mock.calls).toEqual([[ORG, 'stuck']]);
    expect(connections.enqueueVerify.mock.calls).toEqual([[ORG, 'c-pending', expect.any(Date)]]);
    expect(orders.enqueuePlace.mock.calls).toEqual([[ORG, 'po-q']]);
  });

  // guards: BR-SOFR-003
  it('пропозиції й завершені запити старші за supplierOfferRetentionDays — soft delete; свіжі лишаються', async () => {
    const { proc, tables } = setup();
    await proc.sweepOrg(ORG);
    expect(tables.supplierOffer.rows.find(o => o.id === 'o-old')!.deletedAt).toBeInstanceOf(Date);
    expect(tables.supplierOffer.rows.find(o => o.id === 'o-new')!.deletedAt).toBeNull();
    expect(
      tables.supplierOfferRequest.rows.find(r => r.id === 'old-done')!.deletedAt,
    ).toBeInstanceOf(Date);
    expect(tables.supplierOfferRequest.rows.find(r => r.id === 'stuck')!.deletedAt).toBeNull();
  });
});
