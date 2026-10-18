import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { MemRow } from '../../cash/cash.spec-fixture';
import {
  CONN_AVD,
  CONN_UTR,
  GOOD,
  GOOD_ANALOG,
  ITEM_MANUAL,
  ITEM_WO,
  itemRow,
  offersHarness,
  ORG,
  SUP_AVD,
  SUP_UTR,
  type OffersHarnessOptions,
} from '../offers/supplier-offers.spec-fixture';
import { SupplierAllocationService } from './supplier-allocation.service';
import { SupplierPriceConverter } from '../offers/supplier-price-converter';
import { ExchangeRatesService } from '../../exchange-rates/exchange-rates.service';

/**
 * Застосування автопідбору (BR-SOFR-008, 009; BR-PL-017): перегляд без запису, одна транзакція,
 * поділ позиції зі знімком на кожну частину, непокрита решта, CAS. Таблиці в пам'яті.
 */
const BATCH = 'b1111111-1111-4111-8111-111111111111';

function setup(opts: OffersHarnessOptions & { itemIds?: string[] } = {}) {
  const h = offersHarness(opts);
  h.t.supplierOfferBatch.rows.push({
    id: BATCH,
    orgId: ORG,
    purpose: 'AUTO',
    strategy: 'CHEAP',
    itemIds: opts.itemIds ?? [ITEM_MANUAL],
    completedAt: new Date(),
    deletedAt: null,
    createdAt: new Date(),
  });
  const service = new SupplierAllocationService(
    h.prisma,
    h.settings,
    new SupplierPriceConverter(h.prisma, new ExchangeRatesService(h.prisma), h.settings),
  );
  let reqSeq = 0;
  const offer = (itemId: string, connectionId: string, over: MemRow = {}) => {
    reqSeq += 1;
    const reqId = `req-${reqSeq}`;
    h.t.supplierOfferRequest.rows.push({
      id: reqId,
      orgId: ORG,
      batchId: BATCH,
      connectionId,
      purchaseListItemId: itemId,
      status: 'DONE',
      cacheOfId: null,
      deletedAt: null,
      createdAt: new Date(),
    });
    const id = `offer-${reqSeq}`;
    h.t.supplierOffer.rows.push({
      id,
      orgId: ORG,
      requestId: reqId,
      connectionId,
      supplierItemId: `si-${reqSeq}`,
      article: 'OC 90',
      brand: 'MAHLE',
      name: 'Фільтр',
      price: 100,
      currencyCode: 'UAH',
      qty: 10,
      qtyIsLowerBound: false,
      warehouseCode: `wh-${reqSeq}`,
      warehouseName: `Склад ${reqSeq}`,
      deliveryDays: 2,
      deliveryDate: null,
      multiplicity: null,
      isAnalog: false,
      offerKey: `key-${reqSeq}`,
      matchedGoodId: GOOD,
      matchStatus: 'matched',
      fetchedAt: new Date(),
      deletedAt: null,
      ...over,
    });
    return id;
  };
  const items = () => h.t.purchaseListItem.rows.filter(r => r.deletedAt === null);
  return { h, service, offer, items };
}

describe('Автопідбір — застосування (BR-SOFR-009)', () => {
  // guards: BR-SOFR-009
  it('dryRun: розподіл повертається, нічого не записано', async () => {
    const { h, service, offer } = setup();
    offer(ITEM_MANUAL, CONN_UTR, { price: 90 });
    offer(ITEM_MANUAL, CONN_AVD, { price: 80 });
    const before = JSON.stringify(h.t.purchaseListItem.rows);
    const res = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    expect(res).toMatchObject({ applied: false, totalUah: 320 });
    expect(res.items[0]).toMatchObject({
      need: 4,
      uncovered: 0,
      parts: [{ supplierId: SUP_AVD, qty: 4, priceUah: 80 }],
    });
    expect(JSON.stringify(h.t.purchaseListItem.rows)).toBe(before);
  });

  // guards: BR-SOFR-009
  it('одна частина — знімок на позицію, AUTO, постачальник і ціна в гривні', async () => {
    const { h, service, offer } = setup({ eurRate: 45 });
    const eur = offer(ITEM_MANUAL, CONN_UTR, { price: 2, currencyCode: 'EUR' }); // 90 грн
    offer(ITEM_MANUAL, CONN_AVD, { price: 95 });
    await service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER');
    const it = h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)!;
    expect(it).toMatchObject({
      supplierId: SUP_UTR,
      expectedPrice: 90,
      offerPrice: 2,
      offerCurrencyCode: 'EUR',
      offerChosenBy: 'AUTO',
      quantity: 4,
    });
    expect(h.t.supplierOffer.rows.find(o => o.id === eur)!.offerKey).toBe(it.offerKey);
  });

  // guards: BR-SOFR-008
  // guards: BR-PL-017
  it('кілька частин — позиція ділиться, знімок на кожну; непокрита решта — OPEN без пропозиції', async () => {
    const { service, offer, items } = setup();
    offer(ITEM_MANUAL, CONN_UTR, { qty: 1, price: 70 });
    offer(ITEM_MANUAL, CONN_AVD, { qty: 2, price: 80 });
    await service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER');
    const parts = items().map(r => [
      r.quantity,
      r.supplierId,
      r.offerChosenBy ?? null,
      r.expectedPrice ?? null,
    ]);
    expect(parts).toEqual(
      expect.arrayContaining([
        [1, SUP_UTR, 'AUTO', 70],
        [2, SUP_AVD, 'AUTO', 80],
        [1, null, null, null],
      ]),
    );
    // Три частини колишньої ручної позиції + позиція з наряду.
    expect(items().filter(r => r.goodId === GOOD && r.status === 'OPEN')).toHaveLength(4);
  });

  // guards: BR-SOFR-008
  it('без supplierAllowSplit — лише склади одного постачальника; решта непокрита', async () => {
    const { service, offer } = setup({ settings: { supplierAllowSplit: false } });
    offer(ITEM_MANUAL, CONN_UTR, { qty: 1, price: 70 });
    offer(ITEM_MANUAL, CONN_AVD, { qty: 2, price: 80 });
    const res = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    expect(res.items[0]).toMatchObject({ uncovered: 3, parts: [{ supplierId: SUP_UTR, qty: 1 }] });
  });

  // guards: BR-SOFR-008
  it('аналоги в автопідборі — лише з налаштуванням, для ручної позиції й наявного в каталозі товару', async () => {
    const analog = {
      isAnalog: true,
      matchedGoodId: GOOD_ANALOG,
      matchStatus: 'matched',
      price: 10,
    };
    const off = setup({ itemIds: [ITEM_MANUAL, ITEM_WO] });
    off.offer(ITEM_MANUAL, CONN_UTR, analog);
    off.offer(ITEM_MANUAL, CONN_AVD, { price: 100 });
    const r1 = await off.service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    expect(r1.items[0].parts).toMatchObject([{ supplierId: SUP_AVD }]);

    const on = setup({
      itemIds: [ITEM_MANUAL, ITEM_WO],
      settings: { supplierAllowAnalogsInAuto: true },
    });
    on.offer(ITEM_MANUAL, CONN_UTR, analog);
    on.offer(ITEM_WO, CONN_UTR, analog);
    on.offer(ITEM_WO, CONN_AVD, { price: 100 });
    await on.service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER');
    const manual = on.h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)!;
    expect(manual).toMatchObject({
      goodId: GOOD_ANALOG,
      originalGoodId: GOOD,
      offerIsAnalog: true,
    });
    // Позиція з наряду аналог не бере навіть з налаштуванням.
    expect(on.h.t.purchaseListItem.rows.find(r => r.id === ITEM_WO)).toMatchObject({
      goodId: GOOD,
      supplierId: SUP_AVD,
    });
  });

  // guards: BR-SOFR-009
  it('позицію змінено між переглядом і застосуванням → 409, нічого не записано (і в інших позиціях)', async () => {
    const { h, service, offer } = setup({ itemIds: [ITEM_MANUAL, ITEM_WO] });
    offer(ITEM_MANUAL, CONN_UTR);
    offer(ITEM_WO, CONN_UTR);
    const before = JSON.stringify(h.t.purchaseListItem.rows);
    const update = h.t.purchaseListItem.updateMany.getMockImplementation()!;
    let calls = 0;
    h.t.purchaseListItem.updateMany.mockImplementation(args => {
      calls += 1;
      if (calls === 2) h.t.purchaseListItem.rows.find(r => r.id === ITEM_WO)!.quantity = 7;
      return update(args);
    });
    await expect(
      service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER'),
    ).rejects.toThrow(ConflictException);
    h.t.purchaseListItem.rows.find(r => r.id === ITEM_WO)!.quantity = 2;
    expect(JSON.stringify(h.t.purchaseListItem.rows)).toBe(before);
  });

  // guards: BR-SOFR-009
  it('застосування з відбитком перегляду: розподіл змінився після перегляду → 409, нічого не записано', async () => {
    const { h, service, offer } = setup();
    offer(ITEM_MANUAL, CONN_UTR);
    const preview = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    expect(preview.previewToken).toMatch(/^[0-9a-f]{40}$/);
    // Між переглядом і «Застосувати» постачальник оновив ціну.
    h.t.supplierOffer.rows[0]!.price = 90;
    const before = JSON.stringify(h.t.purchaseListItem.rows);
    await expect(
      service.allocate(
        ORG,
        { batchId: BATCH, strategy: 'CHEAP', previewToken: preview.previewToken },
        'OWNER',
      ),
    ).rejects.toThrow(ConflictException);
    expect(JSON.stringify(h.t.purchaseListItem.rows)).toBe(before);
    // Свіжий перегляд — застосовується.
    const again = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    const applied = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', previewToken: again.previewToken },
      'OWNER',
    );
    expect(applied.applied).toBe(true);
  });

  // guards: BR-SOFR-008
  it('одна пропозиція (спільний кешований запит) не роздається кільком позиціям понад наявне', async () => {
    const ITEM_2 = '91111111-1111-4111-8111-000000000009';
    const { h, service, offer } = setup({
      items: [itemRow(ITEM_MANUAL, { quantity: 4 }), itemRow(ITEM_2, { quantity: 3 })],
      itemIds: [ITEM_MANUAL, ITEM_2],
    });
    const shared = offer(ITEM_MANUAL, CONN_UTR, { qty: 5 });
    // Друга позиція того ж товару отримала пропозицію з кешу першої.
    h.t.supplierOfferRequest.rows.push({
      id: 'req-cache',
      orgId: ORG,
      batchId: BATCH,
      connectionId: CONN_UTR,
      purchaseListItemId: ITEM_2,
      status: 'DONE',
      cacheOfId: 'req-1',
      deletedAt: null,
      createdAt: new Date(),
    });
    const res = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', dryRun: true },
      'OWNER',
    );
    const byItem = new Map(res.items.map(i => [i.itemId, i]));
    expect(byItem.get(ITEM_MANUAL)!.parts).toEqual([
      expect.objectContaining({ offerId: shared, qty: 4 }),
    ]);
    expect(byItem.get(ITEM_2)!.parts).toEqual([
      expect.objectContaining({ offerId: shared, qty: 1 }),
    ]);
    expect(byItem.get(ITEM_2)!.uncovered).toBe(2);
  });

  // guards: BR-SOFR-005
  it('позиція, раніше замінена аналогом: пропозиція на оригінал повертає товар-оригінал', async () => {
    const { h, service, offer } = setup({
      items: [itemRow(ITEM_MANUAL, { goodId: GOOD_ANALOG, originalGoodId: GOOD })],
    });
    offer(ITEM_MANUAL, CONN_UTR);
    h.t.supplierOfferRequest.rows[0]!.goodId = GOOD; // шукали для оригіналу (до заміни)
    await service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER');
    expect(h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)).toMatchObject({
      goodId: GOOD,
      originalGoodId: null,
      offerKey: 'key-1',
    });
  });

  // guards: BR-SOFR-009
  it('ручний вибір не перезаписується без overrideManual — пропущено з причиною manualChoice', async () => {
    const { h, service, offer } = setup({ itemIds: [ITEM_MANUAL, ITEM_WO] });
    const manual = h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)!;
    Object.assign(manual, {
      offerChosenBy: 'MANUAL',
      offerKey: 'manual-key',
      supplierId: SUP_UTR,
      expectedPrice: 150,
    });
    offer(ITEM_MANUAL, CONN_AVD, { price: 80 });
    offer(ITEM_WO, CONN_AVD, { price: 80 });
    const before = JSON.stringify(manual);
    const res = await service.allocate(ORG, { batchId: BATCH, strategy: 'CHEAP' }, 'OWNER');
    expect(res.items.find(i => i.itemId === ITEM_MANUAL)).toMatchObject({
      skippedReason: 'manualChoice',
      parts: [],
    });
    expect(JSON.stringify(h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL))).toBe(before);
    // Інша позиція того самого пошуку підібрана як звичайно.
    expect(h.t.purchaseListItem.rows.find(r => r.id === ITEM_WO)).toMatchObject({
      supplierId: SUP_AVD,
      offerChosenBy: 'AUTO',
    });
  });

  // guards: BR-SOFR-009
  it('overrideManual: true — ручний вибір замінюється автопідбором', async () => {
    const { h, service, offer } = setup();
    Object.assign(
      h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)!,
      {
        offerChosenBy: 'MANUAL',
        offerKey: 'manual-key',
        supplierId: SUP_UTR,
      },
    );
    offer(ITEM_MANUAL, CONN_AVD, { price: 80 });
    await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'CHEAP', overrideManual: true },
      'OWNER',
    );
    expect(h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)).toMatchObject({
      supplierId: SUP_AVD,
      offerChosenBy: 'AUTO',
      expectedPrice: 80,
    });
  });

  it('позиція не OPEN — пропущена з причиною; ролі без цін бачать null', async () => {
    const { h, service, offer } = setup();
    offer(ITEM_MANUAL, CONN_UTR);
    h.t.purchaseListItem.rows.find(r => r.id === ITEM_MANUAL)!.status = 'ORDERED';
    const res = await service.allocate(
      ORG,
      { batchId: BATCH, strategy: 'FAST', dryRun: true },
      'RECEPTIONIST',
    );
    expect(res.items[0]).toMatchObject({ skippedReason: 'itemNotOpen', parts: [] });
    expect(res.totalUah).toBeNull();
  });
});
