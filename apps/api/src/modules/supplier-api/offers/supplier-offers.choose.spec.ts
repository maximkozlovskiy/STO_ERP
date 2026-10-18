import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { MemRow } from '../../cash/cash.spec-fixture';
import { offerSelectability } from './offer-selectability';
import {
  CONN_UTR,
  GOOD,
  GOOD_ANALOG,
  ITEM_MANUAL,
  ITEM_WO,
  offersHarness,
  ORG,
  OTHER_ORG,
  SUP_UTR,
  type OffersHarnessOptions,
} from './supplier-offers.spec-fixture';

/**
 * Ручний вибір пропозиції (BR-SOFR-005, 006, 010): знімок, гривня, аналоги за політикою,
 * зняття вибору, видимість цін. Справжній сервіс над таблицями в пам'яті.
 */
type OfferOver = Partial<MemRow>;

/** Пропозиція з запиту позиції (запит DONE, як після обробника). */
function withOffer(h: ReturnType<typeof offersHarness>, itemId: string, over: OfferOver = {}) {
  const req: MemRow = {
    id: `req-${h.t.supplierOfferRequest.rows.length + 1}`,
    orgId: ORG,
    batchId: null,
    connectionId: CONN_UTR,
    purchaseListItemId: itemId,
    goodId: GOOD,
    article: 'OC 90',
    articleNormalized: 'OC90',
    brand: 'MAHLE',
    includeAnalogs: true,
    status: 'DONE',
    fromCache: false,
    cacheOfId: null,
    completedAt: new Date(),
    deletedAt: null,
    createdAt: new Date(),
  };
  h.t.supplierOfferRequest.rows.push(req);
  const offer: MemRow = {
    id: `offer-${h.t.supplierOffer.rows.length + 1}`,
    orgId: ORG,
    requestId: req.id,
    connectionId: CONN_UTR,
    supplierItemId: '45000',
    article: 'OC 90',
    articleNormalized: 'OC90',
    brand: 'MAHLE',
    name: 'Фільтр оливи',
    price: 134.28,
    currencyCode: 'UAH',
    qty: 4,
    qtyIsLowerBound: false,
    warehouseCode: '15',
    warehouseName: 'Київ',
    deliveryDays: 2,
    deliveryDate: null,
    multiplicity: 1,
    isAnalog: false,
    offerKey: '45000|15',
    matchedGoodId: GOOD,
    matchStatus: 'matched',
    fetchedAt: new Date(),
    deletedAt: null,
    ...over,
  };
  h.t.supplierOffer.rows.push(offer);
  return offer.id as string;
}

const item = (h: ReturnType<typeof offersHarness>, id: string) =>
  h.t.purchaseListItem.rows.find(r => r.id === id)!;

const setup = (opts: OffersHarnessOptions = {}) => offersHarness(opts);

describe('Вибір пропозиції (BR-SOFR-006)', () => {
  // guards: BR-SOFR-006
  it('постачальник — контрагент підключення, ціна в гривні, знімок і MANUAL', async () => {
    const h = setup();
    const offerId = withOffer(h, ITEM_MANUAL);
    const dto = await h.service.chooseOffer(ORG, ITEM_MANUAL, offerId, 'STOREKEEPER');
    expect(item(h, ITEM_MANUAL)).toMatchObject({
      supplierId: SUP_UTR,
      expectedPrice: 134.28,
      offerConnectionId: CONN_UTR,
      offerKey: '45000|15',
      offerWarehouseCode: '15',
      offerDeliveryDays: 2,
      offerPrice: 134.28,
      offerCurrencyCode: 'UAH',
      offerChosenBy: 'MANUAL',
    });
    expect(item(h, ITEM_MANUAL).offeredAt).toBeInstanceOf(Date);
    expect(dto).toMatchObject({ offerKey: '45000|15', offerPrice: 134.28, expectedPrice: 134.28 });
  });

  // guards: BR-SOFR-006
  it('ціна в EUR → expectedPrice у гривні за курсом; знімок — як у постачальника', async () => {
    const h = setup({ eurRate: 45.5 });
    const offerId = withOffer(h, ITEM_MANUAL, { price: 2.6, currencyCode: 'EUR' });
    await h.service.chooseOffer(ORG, ITEM_MANUAL, offerId, 'OWNER');
    expect(item(h, ITEM_MANUAL)).toMatchObject({
      expectedPrice: 118.3,
      offerPrice: 2.6,
      offerCurrencyCode: 'EUR',
    });
  });

  // guards: BR-SOFR-006
  it('немає курсу валюти → 400 noExchangeRate, позиція не змінена', async () => {
    const h = setup({ eurRate: null });
    const offerId = withOffer(h, ITEM_MANUAL, { price: 2.6, currencyCode: 'EUR' });
    await expect(h.service.chooseOffer(ORG, ITEM_MANUAL, offerId)).rejects.toThrow(
      /Немає курсу валюти EUR/,
    );
    expect(item(h, ITEM_MANUAL).offerKey).toBeNull();
  });

  // guards: BR-SOFR-006
  it('пропозиція іншої позиції або організації → 404 offerNotFound; не OPEN → 400', async () => {
    const h = setup();
    const foreign = withOffer(h, ITEM_WO);
    await expect(h.service.chooseOffer(ORG, ITEM_MANUAL, foreign)).rejects.toThrow(
      NotFoundException,
    );
    await expect(h.service.chooseOffer(OTHER_ORG, ITEM_MANUAL, foreign)).rejects.toThrow(
      NotFoundException,
    );
    const own = withOffer(h, ITEM_MANUAL);
    item(h, ITEM_MANUAL).status = 'ORDERED';
    await expect(h.service.chooseOffer(ORG, ITEM_MANUAL, own)).rejects.toThrow(BadRequestException);
  });

  it('пропозиція з кешу (запит позиції посилається на чужий виконаний) — обирається', async () => {
    const h = setup();
    const offerId = withOffer(h, ITEM_WO);
    const source = h.t.supplierOfferRequest.rows[0];
    h.t.supplierOfferRequest.rows.push({
      ...source,
      id: 'req-cache',
      purchaseListItemId: ITEM_MANUAL,
      cacheOfId: source.id,
      fromCache: true,
    });
    await expect(h.service.chooseOffer(ORG, ITEM_MANUAL, offerId)).resolves.toMatchObject({
      offerKey: '45000|15',
    });
  });

  // guards: BR-PL-005
  it('позицію змінено між читанням і записом → 409', async () => {
    const h = setup();
    const offerId = withOffer(h, ITEM_MANUAL);
    const update = h.t.purchaseListItem.updateMany.getMockImplementation()!;
    h.t.purchaseListItem.updateMany.mockImplementationOnce(args => {
      item(h, ITEM_MANUAL).quantity = 9;
      return update(args);
    });
    await expect(h.service.chooseOffer(ORG, ITEM_MANUAL, offerId)).rejects.toThrow(
      ConflictException,
    );
  });

  // guards: BR-SOFR-006
  it('зняти вибір: знімок очищено, постачальник і ціна лишаються', async () => {
    const h = setup();
    await h.service.chooseOffer(ORG, ITEM_MANUAL, withOffer(h, ITEM_MANUAL));
    await h.service.clearOffer(ORG, ITEM_MANUAL, 'OWNER');
    expect(item(h, ITEM_MANUAL)).toMatchObject({
      supplierId: SUP_UTR,
      expectedPrice: 134.28,
      offerKey: null,
      offerConnectionId: null,
      offerPrice: null,
      offerChosenBy: null,
    });
  });
});

describe('Аналоги (BR-SOFR-005)', () => {
  const analog = {
    article: 'W 712/75',
    articleNormalized: 'W71275',
    brand: 'MANN',
    isAnalog: true,
    offerKey: '45001|15',
    supplierItemId: '45001',
  };

  // guards: BR-SOFR-005
  it('позиція з наряду: аналог не обирається за будь-якої політики', async () => {
    const h = setup({ settings: { supplierAnalogPolicy: 'CREATE_AND_REPLACE' } });
    const offerId = withOffer(h, ITEM_WO, {
      ...analog,
      matchedGoodId: GOOD_ANALOG,
      matchStatus: 'matched',
    });
    await expect(h.service.chooseOffer(ORG, ITEM_WO, offerId)).rejects.toThrow(
      'Цей аналог обрати не можна',
    );
  });

  // guards: BR-SOFR-005
  it('SHOW_ONLY — не обирається; CATALOG_ONLY — лише знайдений у каталозі (товар позиції замінюється)', async () => {
    const show = setup({ settings: { supplierAnalogPolicy: 'SHOW_ONLY' } });
    const o1 = withOffer(show, ITEM_MANUAL, {
      ...analog,
      matchedGoodId: GOOD_ANALOG,
      matchStatus: 'matched',
    });
    await expect(show.service.chooseOffer(ORG, ITEM_MANUAL, o1)).rejects.toThrow(
      BadRequestException,
    );

    const cat = setup({ settings: { supplierAnalogPolicy: 'CATALOG_ONLY' } });
    const notFound = withOffer(cat, ITEM_MANUAL, {
      ...analog,
      matchedGoodId: null,
      matchStatus: 'notFound',
    });
    await expect(cat.service.chooseOffer(ORG, ITEM_MANUAL, notFound)).rejects.toThrow(
      BadRequestException,
    );
    const found = withOffer(cat, ITEM_MANUAL, {
      ...analog,
      matchedGoodId: GOOD_ANALOG,
      matchStatus: 'matched',
    });
    await cat.service.chooseOffer(ORG, ITEM_MANUAL, found);
    expect(item(cat, ITEM_MANUAL)).toMatchObject({
      goodId: GOOD_ANALOG,
      originalGoodId: GOOD,
      offerIsAnalog: true,
    });
  });

  // guards: BR-SOFR-005
  it('CREATE_AND_REPLACE, аналога немає в каталозі → новий товар із ціною продажу вихідного', async () => {
    const h = setup({ settings: { supplierAnalogPolicy: 'CREATE_AND_REPLACE' } });
    const offerId = withOffer(h, ITEM_MANUAL, {
      ...analog,
      matchedGoodId: null,
      matchStatus: 'notFound',
    });
    await h.service.chooseOffer(ORG, ITEM_MANUAL, offerId);
    expect(h.goods.create).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        sku: 'W 712/75',
        salePrice: 250,
        purchasePrice: 134.28,
        unit: 'шт',
        goodCategoryId: 'cat-1',
        preferredSupplierId: SUP_UTR,
      }),
      'OWNER',
    );
    const it = item(h, ITEM_MANUAL);
    expect(it.goodId).toMatch(/^good-new-/);
    expect(it.originalGoodId).toBe(GOOD);
  });

  // guards: BR-SOFR-005
  it('CREATE_AND_REPLACE з неоднозначним збігом — не обирається (невідомо, який товар)', () => {
    expect(
      offerSelectability({
        isAnalog: true,
        matchStatus: 'ambiguous',
        matchedGoodId: null,
        itemSource: 'MANUAL',
        itemOpen: true,
        policy: 'CREATE_AND_REPLACE',
        priceUah: 1,
      }),
    ).toEqual({ selectable: false, reason: 'analogAmbiguous', replacesGood: false });
  });
});

describe('Видимість цін пропозицій (BR-SOFR-010)', () => {
  // guards: BR-SOFR-010
  it('приймальня й механік отримують null замість цін пропозицій і знімка', async () => {
    const h = setup();
    const offerId = withOffer(h, ITEM_MANUAL);
    const forReceptionist = await h.service.chooseOffer(ORG, ITEM_MANUAL, offerId, 'RECEPTIONIST');
    expect(forReceptionist).toMatchObject({
      offerPrice: null,
      expectedPrice: null,
      offerKey: '45000|15',
    });
    for (const role of ['RECEPTIONIST', 'MECHANIC', undefined]) {
      const view = await h.service.itemOffers(ORG, ITEM_MANUAL, role);
      expect(view.requests[0].offers[0]).toMatchObject({ price: null, priceUah: null });
    }
    const owner = await h.service.itemOffers(ORG, ITEM_MANUAL, 'STOREKEEPER');
    expect(owner.requests[0].offers[0]).toMatchObject({
      price: 134.28,
      priceUah: 134.28,
      chosen: true,
    });
  });
});

describe('offerSelectability — таблиця рішень', () => {
  const base = {
    isAnalog: false,
    matchStatus: 'matched',
    matchedGoodId: GOOD,
    itemSource: 'MANUAL' as const,
    itemOpen: true,
    policy: 'CATALOG_ONLY' as const,
    priceUah: 10,
  };
  it.each([
    [{}, true, null],
    [{ itemOpen: false }, false, 'itemNotOpen'],
    [{ priceUah: null }, false, 'noExchangeRate'],
    [{ isAnalog: true, itemSource: 'WORK_ORDER' as const }, false, 'analogFromWorkOrder'],
    [{ isAnalog: true, policy: 'SHOW_ONLY' as const }, false, 'analogShowOnly'],
    [{ isAnalog: true, matchStatus: 'notFound', matchedGoodId: null }, false, 'analogNotInCatalog'],
    [{ isAnalog: true }, true, null],
    [
      {
        isAnalog: true,
        policy: 'CREATE_AND_REPLACE' as const,
        matchStatus: 'notFound',
        matchedGoodId: null,
      },
      true,
      null,
    ],
  ])('%j → selectable=%s, reason=%s', (over, selectable, reason) => {
    expect(offerSelectability({ ...base, ...over })).toMatchObject({ selectable, reason });
  });
});
