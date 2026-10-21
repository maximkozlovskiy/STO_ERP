import { BadRequestException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { SupplierAuthError, SupplierNetworkError } from '../http/supplier-errors';
import { SupplierReconcileRequired } from './place-order-runner';
import { UNKNOWN_ORDER_MESSAGE } from './supplier-order-sender';
import {
  fakeAdapter,
  offerItem,
  ordersHarness,
  ORG,
  SETTINGS,
} from './supplier-orders.spec-fixture';
import { WO_A, partRow, woRow } from '../../purchase-lists/purchase-lists.spec-fixture';

/**
 * Відправка замовлення в API постачальника (BR-SCON-009…011, BR-PO-011): кнопка, outbox,
 * відновлення по кроках, звірка після неоднозначної відмови. Справжні сервіси над таблицями в
 * пам'яті; адаптер — підставний з лічильниками.
 */
describe('BR-SCON-009 «Відправити в API»', () => {
  // guards: BR-SCON-009
  it('з «Чернетки»: спершу «Замовлено», потім план і задача place; supplierApiStatus = QUEUED', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    const state = await x.service.send(ORG, poId, 'STOREKEEPER');
    expect(x.po(poId)).toMatchObject({ status: 'ORDERED', supplierApiStatus: 'QUEUED' });
    expect(x.supplierOrders()).toHaveLength(1);
    const so = x.supplierOrders()[0];
    // reference глобально унікальний: номер замовлення (його нумерацію можна скинути) + id.
    expect(so).toMatchObject({
      status: 'QUEUED',
      reference: expect.stringMatching(/^STO-ЗП-2026-\d+-1-[0-9a-f]{8}$/),
    });
    expect(so.reference).toMatch(new RegExp(`-${String(so.id).slice(0, 8)}$`));
    expect(x.lines()[0]).toMatchObject({
      offerKey: 'p1|w1',
      supplierItemId: 'p1',
      qtyRequested: 4,
      priceRequested: 120,
    });
    expect(x.queueAdd).toHaveBeenCalledWith(
      'place',
      { orgId: ORG, purchaseOrderId: poId },
      expect.objectContaining({
        attempts: 10,
        backoff: { type: 'exponential', delay: 30_000 },
        jobId: `supplier-place-${poId}`,
        // Сталий jobId + failed-задача в Redis = повторна відправка / sweep мовчки ігноруються.
        removeOnFail: true,
      }),
    );
    expect(x.locks).toContain(poId);
    expect(state).toMatchObject({ supplierApiStatus: 'QUEUED', canSend: false });
  });

  // guards: BR-SCON-010
  it('план неможливий (позиція без пропозиції) → 400, статус замовлення не змінено', async () => {
    const x = ordersHarness({
      items: [offerItem('i1', { offerKey: null, offerConnectionId: null })],
    });
    const poId = await x.draftFromItems();
    await expect(x.service.send(ORG, poId)).rejects.toThrow(
      /Не обрано пропозицію постачальника для товарів: Фільтр/,
    );
    expect(x.po(poId)).toMatchObject({ status: 'DRAFT', supplierApiStatus: 'NOT_SENT' });
    expect(x.supplierOrders()).toHaveLength(0);
  });

  // guards: BR-SCON-009 — відправка лише з «Чернетки» чи «Замовлено» (рішення власника 2026-10-18)
  it('вже відправлене → 400 alreadySent; частково отримане / отримане / скасоване → 400 orderClosed', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    x.po(poId).supplierApiStatus = 'SENT';
    await expect(x.service.send(ORG, poId)).rejects.toThrow(
      'Замовлення вже передане постачальнику',
    );
    // NOT_SENT — інакше 400 alreadySent замаскував би відсутню перевірку статусу замовлення.
    x.po(poId).supplierApiStatus = 'NOT_SENT';
    for (const status of ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']) {
      x.po(poId).status = status;
      const sent = x.service.send(ORG, poId);
      await expect(sent, status).rejects.toThrow(BadRequestException);
      await expect(sent, status).rejects.toThrow(
        'Відправити в API можна лише замовлення в статусі «Чернетка» чи «Замовлено»',
      );
    }
    expect(x.supplierOrders()).toHaveLength(0);
  });

  // guards: BR-SCON-009
  it('режим ON_ORDERED: перехід у «Замовлено» в тій самій транзакції ставить QUEUED і подію після коміту', async () => {
    const x = ordersHarness({ settings: { supplierOrderSendMode: 'ON_ORDERED' } });
    x.h.tables.organisationSettings.rows[0].supplierOrderSendMode = 'ON_ORDERED';
    const poId = await x.draftFromItems();
    await x.h.purchaseOrders.transition(ORG, poId, 'ORDERED');
    expect(x.po(poId).supplierApiStatus).toBe('QUEUED');
    expect(x.h.outboxEvents.emit).toHaveBeenCalledWith('supplier-order.queued', {
      orgId: ORG,
      purchaseOrderId: poId,
    });
    // Подія → задача; обробник сам будує план (outbox-шлях).
    await x.service.onQueued({ orgId: ORG, purchaseOrderId: poId });
    expect(x.queueAdd).toHaveBeenCalledWith(
      'place',
      { orgId: ORG, purchaseOrderId: poId },
      expect.anything(),
    );
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()[0]).toMatchObject({ status: 'CONFIRMED', externalNumber: 'EXT-1' });
    expect(x.po(poId).supplierApiStatus).toBe('CONFIRMED');
  });

  // guards: BR-SCON-009
  it('режим MANUAL або замовлення без позицій з пропозицією — перехід outbox не чіпає', async () => {
    const manual = ordersHarness();
    const poId = await manual.draftFromItems();
    await manual.h.purchaseOrders.transition(ORG, poId, 'ORDERED');
    expect(manual.po(poId).supplierApiStatus).toBe('NOT_SENT');

    const noOffer = ordersHarness({
      items: [offerItem('i1', { offerKey: null, offerConnectionId: null })],
    });
    noOffer.h.tables.organisationSettings.rows[0].supplierOrderSendMode = 'ON_ORDERED';
    const po2 = await noOffer.draftFromItems();
    await noOffer.h.purchaseOrders.transition(ORG, po2, 'ORDERED');
    expect(noOffer.po(po2).supplierApiStatus).toBe('NOT_SENT');
  });
});

describe('BR-SCON-011 відправка по кроках без подвійного замовлення', () => {
  // guards: BR-SCON-011
  it('кроки записуються; підтверджене постачальником — у рядках; частково → PARTIALLY_CONFIRMED і PARTIAL', async () => {
    const fa = fakeAdapter({
      result: {
        status: 'CONFIRMED',
        statusRaw: 'ok',
        lines: [{ supplierItemId: 'p1', warehouseCode: 'w1', qtyConfirmed: 3 }],
      },
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()[0]).toMatchObject({
      status: 'PARTIALLY_CONFIRMED',
      step: 'DONE',
      externalOrderId: 'cart-1',
      externalNumber: 'EXT-1',
    });
    expect(x.supplierOrders()[0].sentAt).toBeInstanceOf(Date);
    expect(x.supplierOrders()[0].nextPollAt).toBeInstanceOf(Date);
    expect(x.lines()[0]).toMatchObject({ qtyConfirmed: 3 });
    expect(x.po(poId).supplierApiStatus).toBe('PARTIAL');
  });

  // guards: BR-SCON-011
  it('повтор задачі після обриву між кроками продовжує з записаного кроку: кошик не створюється вдруге', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', "AVD: немає зв'язку", false)),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(SupplierNetworkError);
    expect(x.supplierOrders()[0]).toMatchObject({
      status: 'SENDING',
      step: 'CART',
      externalCartId: 'cart-1',
    });
    fa.behaviour.checkout = () => Promise.resolve();
    await x.sender.run(x.job(poId, 1), undefined);
    expect(fa.calls).toMatchObject({ cart: 1, checkout: 2 });
    expect(x.supplierOrders()[0]).toMatchObject({ status: 'CONFIRMED', externalCartId: 'cart-1' });
  });

  // guards: BR-SCON-011
  it('тайм-аут оформлення → RECONCILE; наступна спроба лише звіряє: знайдено → PLACED, без другого оформлення', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', 'AVD: тайм-аут запиту', true)),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(x.supplierOrders()[0].step).toBe('RECONCILE');
    fa.behaviour.found = { externalOrderId: 'ord-77', externalNumber: 'AGS77' };
    await x.sender.run(x.job(poId, 1), undefined);
    expect(fa.calls).toMatchObject({ checkout: 1, find: 1 });
    expect(x.supplierOrders()[0]).toMatchObject({
      status: 'PLACED',
      externalOrderId: 'ord-77',
      externalNumber: 'AGS77',
      step: 'DONE',
    });
    expect(x.po(poId).supplierApiStatus).toBe('SENT');
  });

  // guards: BR-SCON-011
  it('звірка не знайшла → UNKNOWN, замовлення NEEDS_ATTENTION з порадою перевірити кабінет', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', 'AVD: тайм-аут запиту', true)),
      found: null,
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    await x.sender.run(x.job(poId, 1), undefined);
    expect(fa.calls.checkout).toBe(1);
    expect(x.supplierOrders()[0]).toMatchObject({
      status: 'UNKNOWN',
      error: UNKNOWN_ORDER_MESSAGE,
    });
    expect(x.po(poId)).toMatchObject({
      supplierApiStatus: 'NEEDS_ATTENTION',
      supplierApiError: UNKNOWN_ORDER_MESSAGE,
    });
  });

  // guards: BR-SCON-011
  it('рестарт посеред неповторюваного кроку (лишився CHECKOUT:PENDING) — теж звірка, не повтор', async () => {
    const fa = fakeAdapter({ found: { externalOrderId: 'ord-1', externalNumber: null } });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    Object.assign(x.supplierOrders()[0], {
      step: 'CHECKOUT:PENDING',
      status: 'SENDING',
      externalCartId: 'cart-1',
    });
    await x.sender.run(x.job(poId), undefined);
    expect(fa.calls).toMatchObject({ cart: 0, checkout: 0, find: 1 });
    expect(x.supplierOrders()[0].status).toBe('PLACED');
  });

  // guards: BR-SCON-006
  it('невірні креди → FAILED з причиною, UnrecoverableError; повторна відправка продовжує ті самі зовнішні замовлення', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierAuthError('AVD', 'AVD 401: ключ', 401)),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(x.supplierOrders()[0]).toMatchObject({
      status: 'FAILED',
      error: 'AVD 401: ключ',
      step: 'CART',
    });
    expect(x.po(poId)).toMatchObject({
      supplierApiStatus: 'FAILED',
      supplierApiError: 'AVD 401: ключ',
    });
    fa.behaviour.checkout = () => Promise.resolve();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()).toHaveLength(1);
    expect(fa.calls.cart).toBe(1);
    expect(x.supplierOrders()[0].status).toBe('CONFIRMED');
  });

  // guards: BR-SCON-011
  it('спроби вичерпано посеред звірки → UNKNOWN (не «не сталося»)', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', 'AVD: тайм-аут запиту', true)),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId, 9), undefined)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(x.supplierOrders()[0].status).toBe('UNKNOWN');
  });

  it('замовлення скасовано до відправки — обробник нічого не відправляє', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.h.purchaseOrders.transition(ORG, poId, 'CANCELLED');
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()[0].status).toBe('CANCELLED');
    expect(x.fa.adapter.placeOrder).not.toHaveBeenCalled();
  });

  // guards: BR-SCON-014
  it('скасовано між вибіркою й відправкою — рядок не «воскресає» в SENDING, постачальнику нічого', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    // Налаштування читаються одразу після вибірки рядків — саме тоді «приходить» скасування.
    (x.settings.getOrganisationSettings as Mock).mockImplementationOnce(() => {
      x.supplierOrders()[0].status = 'CANCELLED';
      return Promise.resolve(SETTINGS);
    });
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()[0].status).toBe('CANCELLED');
    expect(x.fa.adapter.placeOrder).not.toHaveBeenCalled();
  });

  // guards: BR-SCON-014
  it('outbox-шлях: замовлення скасовано до блокування — план не будується', async () => {
    const x = ordersHarness();
    x.h.tables.organisationSettings.rows[0].supplierOrderSendMode = 'ON_ORDERED';
    const poId = await x.draftFromItems();
    await x.h.purchaseOrders.transition(ORG, poId, 'ORDERED');
    expect(x.po(poId).supplierApiStatus).toBe('QUEUED');
    const prismaRec = x.h.prisma as unknown as Record<string, unknown>;
    const lock = prismaRec.$queryRaw as (...a: unknown[]) => Promise<unknown>;
    prismaRec.$queryRaw = vi.fn((...a: unknown[]) => {
      x.po(poId).status = 'CANCELLED'; // скасування закомітилось між першим читанням і FOR UPDATE
      return lock(...a);
    });
    await x.sender.run(x.job(poId), undefined);
    expect(x.supplierOrders()).toHaveLength(0);
    expect(x.fa.adapter.placeOrder).not.toHaveBeenCalled();
  });

  // guards: BR-SCON-006
  it('остаточна відмова одного зовнішнього замовлення не лишає решту в QUEUED', async () => {
    let n = 0;
    const fa = fakeAdapter({
      checkout: () =>
        ++n === 1
          ? Promise.reject(new SupplierAuthError('AVD', 'AVD 401: ключ', 401))
          : Promise.resolve(),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    const [first] = x.supplierOrders();
    x.t.supplierOrder.rows.push({
      ...first,
      id: 'so-2',
      reference: `${String(first.reference)}-b`,
      createdAt: new Date((first.createdAt as Date).getTime() + 1000),
    });
    x.t.supplierOrderLine.rows.push({ ...x.lines()[0], id: 'sol-2', supplierOrderId: 'so-2' });
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(x.supplierOrders().map(o => o.status)).toEqual(['FAILED', 'CONFIRMED']);
    expect(x.po(poId).supplierApiStatus).toBe('FAILED');
  });

  // guards: BR-SCON-011
  it('неповторюваний крок почався — sentAt записано одразу (звірка шукає від дати відправки)', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', 'AVD: тайм-аут запиту', true)),
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    const sentAt = x.supplierOrders()[0].sentAt;
    expect(sentAt).toBeInstanceOf(Date);
    await x.sender.run(x.job(poId, 1), undefined);
    expect((fa.adapter.findOrderByReference as Mock).mock.calls[0][1]).toMatchObject({ sentAt });
  });
});

describe('BR-SCON-012 статуси й BR-PO-011: склад і FSM не змінюються', () => {
  // guards: BR-SCON-012
  it('опитування: сирий → нормалізований за таблицею; невідомий — лише сирий; термінальний — стоп', async () => {
    const fa = fakeAdapter();
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    const so = x.supplierOrders()[0];
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so).toMatchObject({ status: 'READY', externalStatusRaw: 'Готовий' });
    fa.behaviour.status = { statusRaw: 'Щось нове', status: null };
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so).toMatchObject({ status: 'READY', externalStatusRaw: 'Щось нове' });
    fa.behaviour.status = { statusRaw: 'Відвантажено', status: 'SHIPPED' };
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so).toMatchObject({ status: 'SHIPPED', nextPollAt: null });
  });

  // guards: BR-SCON-012 — опитування не довше 30 днів від відправки (рішення власника 2026-10-18)
  it('опитування: нетермінальне замовлення старше 30 днів від відправки більше не опитується', async () => {
    const fa = fakeAdapter();
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    const so = x.supplierOrders()[0];
    const DAY = 86_400_000;
    so.sentAt = new Date(Date.now() - 29 * DAY);
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so.status).toBe('READY');
    expect(so.nextPollAt).toBeInstanceOf(Date);
    so.sentAt = new Date(Date.now() - 31 * DAY);
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so).toMatchObject({ status: 'READY', nextPollAt: null });
  });

  // sto-optimize 2026-10-18: замовлення видаленого підключення опитати нічим, і nextPollAt у нього
  // не рухався — воно лишалось «на черзі» назавжди: кожні 5 хв читалось, переписувало підсумок
  // замовлення (syncVersion) і, набравши DUE_BATCH, витісняло живі замовлення.
  it('опитування: замовлення видаленого підключення не вибирається — підсумок не переписується', async () => {
    const fa = fakeAdapter();
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    const so = x.supplierOrders()[0];
    so.nextPollAt = new Date(Date.now() - 1000);
    x.t.supplierConnection.rows.find(c => c.id === so.connectionId)!.deletedAt = new Date();
    const refresh = vi.spyOn(x.service, 'refreshSummary');
    await x.poller.pollDue();
    expect(refresh).not.toHaveBeenCalled();
    expect(fa.calls.status).toBe(0);
  });

  // guards: BR-PO-011
  it('зовнішній статус не змінює залишків і FSM замовлення', async () => {
    const fa = fakeAdapter({ status: { statusRaw: 'Відвантажено', status: 'SHIPPED' } });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    const movementsBefore = x.t.stockMovement.rows.length;
    x.supplierOrders()[0].nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(x.supplierOrders()[0].status).toBe('SHIPPED');
    expect(x.t.stockMovement.rows).toHaveLength(movementsBefore);
    expect(x.po(poId).status).toBe('ORDERED');
    expect(x.h.item('i1')).toMatchObject({ status: 'ORDERED', receivedQty: 0 });
  });

  // guards: BR-SCON-011
  it('UNKNOWN опитується звіркою: замовлення з’явилось у постачальника → PLACED', async () => {
    const fa = fakeAdapter({
      checkout: () => Promise.reject(new SupplierNetworkError('AVD', 'тайм-аут', true)),
      found: null,
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await expect(x.sender.run(x.job(poId), undefined)).rejects.toThrow();
    await x.sender.run(x.job(poId, 1), undefined);
    const so = x.supplierOrders()[0];
    expect(so.status).toBe('UNKNOWN');
    fa.behaviour.found = { externalOrderId: 'late-1', externalNumber: 'N-1' };
    so.nextPollAt = new Date(Date.now() - 1000);
    await x.poller.pollDue();
    expect(so).toMatchObject({ status: 'PLACED', externalOrderId: 'late-1' });
    expect(x.po(poId).supplierApiStatus).toBe('SENT');
  });

  // guards: BR-SCON-006
  it('«Оновити статус»: одна задача на замовлення; невірні креди — без 10 марних повторів', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    await x.service.requestPoll(ORG, poId);
    expect(x.queueAdd).toHaveBeenLastCalledWith(
      'poll-now',
      { orgId: ORG, purchaseOrderId: poId },
      expect.objectContaining({ jobId: `supplier-poll-now-${poId}`, removeOnFail: true }),
    );
    (x.fa.adapter.getOrderStatus as Mock).mockRejectedValueOnce(
      new SupplierAuthError('AVD', 'AVD 401: ключ', 401),
    );
    await expect(x.poller.pollPurchaseOrder(x.job(poId), undefined)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('BR-SCON-013 / BR-SCON-014 / BR-PO-012', () => {
  // guards: BR-SCON-013
  it('«Повернути непідтверджене»: понад підтверджене — в OPEN без пропозиції; вдруге — 400 nothingToRelease', async () => {
    const fa = fakeAdapter({
      result: {
        status: 'CONFIRMED',
        statusRaw: 'ok',
        lines: [{ supplierItemId: 'p1', warehouseCode: 'w1', qtyConfirmed: 1 }],
      },
    });
    const x = ordersHarness({ adapter: fa.adapter });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    expect((await x.service.getState(ORG, poId)).canRelease).toBe(true);
    const res = await x.service.releaseUnconfirmed(ORG, poId, 'OWNER');
    expect(res.released).toBe(3);
    expect(x.h.item('i1')).toMatchObject({ status: 'ORDERED', quantity: 1, offerKey: 'p1|w1' });
    const back = x.h.liveItems().find(r => r.id !== 'i1')!;
    expect(back).toMatchObject({ status: 'OPEN', quantity: 3 });
    expect(back.offerKey ?? null).toBeNull();
    expect(res.state.canRelease).toBe(false);
    await expect(x.service.releaseUnconfirmed(ORG, poId)).rejects.toThrow(
      'Непідтвердженої кількості немає',
    );
  });

  // guards: BR-SCON-013
  it.each([
    ['скасовано', { status: 'CANCELLED' }],
    ['завершено', { status: 'COMPLETED' }],
    ['видалено', { status: 'APPROVED', deletedAt: new Date('2026-10-20T09:00:00Z') }],
  ])(
    '«Повернути непідтверджене»: наряд позиції %s → повернене «Скасовано», не «Не замовлено» (Bug #912)',
    async (_state, wo) => {
      const fa = fakeAdapter({
        result: {
          status: 'CONFIRMED',
          statusRaw: 'ok',
          lines: [{ supplierItemId: 'p1', warehouseCode: 'w1', qtyConfirmed: 1 }],
        },
      });
      const x = ordersHarness({
        adapter: fa.adapter,
        items: [
          offerItem('i1', { source: 'WORK_ORDER', workOrderId: WO_A, workOrderPartId: 'pa' }),
        ],
        workOrders: [woRow(WO_A, { status: 'APPROVED' })],
        parts: [partRow('pa', WO_A, { quantity: 4 })],
      });
      const poId = await x.draftFromItems();
      await x.service.send(ORG, poId);
      await x.sender.run(x.job(poId), undefined);
      Object.assign(x.t.workOrder.rows[0], wo);

      expect((await x.service.releaseUnconfirmed(ORG, poId, 'OWNER')).released).toBe(3);

      const back = x.h.liveItems().find(r => r.id !== 'i1')!;
      expect(back).toMatchObject({ status: 'CANCELLED', quantity: 3, workOrderId: WO_A });
      expect(back.purchaseOrderId ?? null).toBeNull();
      expect(x.h.liveItems().filter(r => r.status === 'OPEN')).toEqual([]);
    },
  );

  // guards: BR-SCON-013
  it('«Повернути непідтверджене»: потребу наряду зменшили, поки замовлення в постачальника → OPEN лише на непокрите (Bug #912)', async () => {
    const fa = fakeAdapter({
      result: {
        status: 'CONFIRMED',
        statusRaw: 'ok',
        lines: [{ supplierItemId: 'p1', warehouseCode: 'w1', qtyConfirmed: 1 }],
      },
    });
    const x = ordersHarness({
      adapter: fa.adapter,
      items: [offerItem('i1', { source: 'WORK_ORDER', workOrderId: WO_A, workOrderPartId: 'pa' })],
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('pa', WO_A, { quantity: 4 })],
    });
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    x.t.workOrderPart.rows[0].quantity = 2; // 4 → 2: ORDERED не урізаються (BR-PL-013)

    await x.service.releaseUnconfirmed(ORG, poId, 'OWNER');

    // Підтверджено 1 (ORDERED) + OPEN мусить дати рівно потребу 2, а не 1 + 3.
    expect(x.h.item('i1')).toMatchObject({ status: 'ORDERED', quantity: 1 });
    const open = x.h.liveItems().filter(r => r.status === 'OPEN');
    expect(open.reduce((s, r) => s + (r.quantity as number), 0)).toBe(1);
  });

  // guards: BR-SCON-014
  // guards: BR-PO-012
  it('скасування відправленого → 400 cancelSentOrder; з force — скасовано, постачальнику нічого', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    await x.sender.run(x.job(poId), undefined);
    await expect(x.h.purchaseOrders.transition(ORG, poId, 'CANCELLED')).rejects.toThrow(
      /скасуйте його в кабінеті постачальника/,
    );
    expect(x.po(poId).status).toBe('ORDERED');
    const callsBefore = (x.fa.adapter.placeOrder as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    await x.h.purchaseOrders.transition(ORG, poId, 'CANCELLED', { force: true });
    expect(x.po(poId).status).toBe('CANCELLED');
    expect(
      (x.fa.adapter.placeOrder as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(callsBefore);
    expect(x.supplierOrders()[0].status).toBe('CONFIRMED');
  });

  // guards: BR-SCON-014
  it('FAILED після частини кроків, але з зовнішнім id (резерв є, відвантаження впало) — теж відправлене', async () => {
    const x = ordersHarness();
    const poId = await x.draftFromItems();
    await x.service.send(ORG, poId);
    const so = x.supplierOrders()[0];
    Object.assign(so, { status: 'FAILED', step: 'RESERVE', externalOrderId: 'res-1' });
    x.po(poId).supplierApiStatus = 'FAILED';
    await expect(x.h.purchaseOrders.transition(ORG, poId, 'CANCELLED')).rejects.toThrow(
      /скасуйте його в кабінеті постачальника/,
    );
    // Лише кошик (зовнішнього замовлення ще немає) — скасування без force.
    // (відкат транзакції підміняє рядки копіями — беремо рядок заново)
    Object.assign(x.supplierOrders()[0], {
      step: 'CART',
      externalCartId: 'cart-1',
      externalOrderId: null,
    });
    await x.h.purchaseOrders.transition(ORG, poId, 'CANCELLED');
    expect(x.po(poId).status).toBe('CANCELLED');
  });

  it('стан: попередження про застарілу пропозицію до відправки', async () => {
    const x = ordersHarness({
      items: [offerItem('i1', { offeredAt: new Date(Date.now() - 2 * 3_600_000) })],
    });
    const poId = await x.draftFromItems();
    const state = await x.service.getState(ORG, poId);
    expect(state).toMatchObject({
      canSend: true,
      hasConnection: true,
      supplierApiStatus: 'NOT_SENT',
    });
    expect(state.warnings).toEqual([expect.stringMatching(/Пропозиція застаріла.*Фільтр/)]);
  });
});
