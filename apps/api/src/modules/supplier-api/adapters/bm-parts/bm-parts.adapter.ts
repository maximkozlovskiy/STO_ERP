import { Injectable } from '@nestjs/common';
import { SupplierHttpClient, type SupplierHttpRequest } from '../../http/supplier-http.client';
import { SupplierProtocolError } from '../../http/supplier-errors';
import {
  asArray,
  asRecord,
  baseUrlOf,
  keepValidOffers,
  requireCredential,
  sameArticle,
  sameBrand,
  str,
} from '../adapter-utils';
import type {
  FoundOrder,
  NormalizedOffer,
  PlacedOrderResult,
  PlaceOrderRunner,
  SupplierAdapter,
  SupplierConnectionContext,
  SupplierOrderInput,
  SupplierOrderState,
  SupplierOrderStatusResult,
  SupplierSearchQuery,
} from '../supplier-adapter.interface';
import {
  BM_BRANCH_STATUS,
  bmCards,
  bmCardToOffers,
  bmReserveLines,
  findBmReserve,
  parseBmOfferKey,
} from './bm-parts.mapper';

const NAME = 'BM Parts';
export const BM_PROD_URL = 'https://api.bm.parts';
/** Скільки точних збігів перевіряти на аналоги (по запиту на товар). */
const ANALOG_LOOKUPS = 3;
const DEFAULT_USER_AGENT = 'STO-ERP';

/**
 * BM Parts (https://developer.bm.parts/openapi.json). Токен — заголовок `Authorization` (без
 * «Bearer», як у прикладах документації), обов'язковий `User-Agent` (без нього 403), тестовий
 * режим — `X-Test-Mode: 1`. Ліміт за замовчуванням — 10 000 запитів на годину на токен.
 * Замовлення — по складу постачальника: кошик із товарами → резерв (`/shopping/reserve/process`,
 * коментар-reference) → за налаштованим конфігом доставки — відвантаження резерву найближчим
 * рейсом (`/processing/departures` + `/processing/reserve/process`). Звірка й статус —
 * `GET /shopping/reserves` за коментарем / uuid резерву.
 */
@Injectable()
export class BmPartsAdapter implements SupplierAdapter {
  readonly provider = 'BM_PARTS' as const;
  readonly name = 'BM Parts';
  readonly capabilities = {
    search: 'online',
    analogs: true,
    order: 'cart',
    sandbox: true,
    orderPerWarehouse: true,
    requiresWarehouseMapping: false,
  } as const;
  readonly credentialFields = [
    {
      key: 'token',
      label: 'API-токен (Authorization)',
      secret: true,
      required: true,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['credentialFields'];
  readonly optionFields = [
    {
      key: 'userAgent',
      label: 'User-Agent (код контрагента або назва застосунку)',
      secret: false,
      required: false,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['optionFields'];
  readonly warehouseFields = [
    {
      key: 'deliveryConfigUuid',
      label: 'Налаштування доставки BM (GET /delivery/configs); порожньо — лише резерв',
      secret: false,
      required: false,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['warehouseFields'];
  readonly orderSteps = ['CART', 'RESERVE', 'SHIP'] as const;

  constructor(private readonly http: SupplierHttpClient) {}

  async verify(conn: SupplierConnectionContext): Promise<void> {
    await this.call(conn, { method: 'GET', path: '/profile/me' });
  }

  async search(
    conn: SupplierConnectionContext,
    q: SupplierSearchQuery,
  ): Promise<NormalizedOffer[]> {
    const r = await this.call<{ products?: unknown }>(conn, {
      method: 'GET',
      path: '/search/products',
      query: {
        q: q.article,
        search_mode: 'strict',
        products_as: 'arr',
        warehouses: 'all',
        per_page: 50,
      },
    });
    const cards = bmCards(r.products);
    const isExact = (c: { card: unknown }) => {
      const rec = asRecord(c.card);
      return sameArticle(str(rec.article) ?? '', q.article) && sameBrand(str(rec.brand), q.brand);
    };
    const offers: NormalizedOffer[] = cards.flatMap(c =>
      bmCardToOffers(c.card, c.uuid, !isExact(c)),
    );
    if (q.includeAnalogs) {
      const exact = cards.filter(isExact).slice(0, ANALOG_LOOKUPS);
      for (const c of exact) {
        const uuid = c.uuid ?? str(asRecord(c.card).uuid);
        if (!uuid) continue;
        const d = await this.call<{ product?: { analogs?: unknown } }>(conn, {
          method: 'GET',
          path: `/product/${encodeURIComponent(uuid)}`,
          query: { analogs_available: '1', warehouses: 'all' },
        });
        for (const a of bmCards(d.product?.analogs))
          offers.push(...bmCardToOffers(a.card, a.uuid, true));
      }
    }
    const seen = new Set<string>();
    return keepValidOffers(offers).filter(o =>
      seen.has(o.offerKey) ? false : seen.add(o.offerKey),
    );
  }

  async placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult> {
    const warehouse =
      order.supplierWarehouseCode ?? parseBmOfferKey(order.lines[0]?.offerKey ?? '').warehouseUuid;
    if (!warehouse)
      throw new SupplierProtocolError(NAME, `${NAME}: замовлення без складу постачальника`);
    let reserve: Record<string, unknown> | null = null;

    await run.step('CART', { repeatable: true }, async () => {
      const r = await this.call<{ carts?: unknown }>(conn, {
        method: 'POST',
        path: '/shopping/carts',
        body: {
          name: order.reference,
          comment: order.reference,
          warehouse,
          products: order.lines.map(l => ({
            uuid: parseBmOfferKey(l.offerKey).productUuid || l.supplierItemId,
            qnt: Math.ceil(l.qty),
          })),
        },
      });
      const cart = asRecord(Array.isArray(r.carts) ? r.carts[0] : r.carts);
      const uuid = str(cart.uuid);
      if (!uuid)
        throw new SupplierProtocolError(NAME, `${NAME}: кошик створено без uuid`, null, true);
      return { externalCartId: uuid };
    });

    await run.step('RESERVE', { repeatable: false }, async () => {
      const r = await this.call<Record<string, unknown>>(conn, {
        method: 'POST',
        path: '/shopping/reserve/process',
        body: {
          order_uuid: run.state.externalCartId,
          warehouse_uuid: warehouse,
          comment: order.reference,
        },
      });
      if (r.result === false) {
        throw new SupplierProtocolError(
          NAME,
          `${NAME}: резерв відхилено — ${str(r.error) ?? 'без причини'}`,
        );
      }
      const uuid = str(r.uuid);
      if (!uuid) throw new SupplierProtocolError(NAME, `${NAME}: резерв без uuid`, null, true);
      reserve = r;
      return { externalOrderId: uuid };
    });

    const deliveryConfig = conn.options.warehouses?.[order.ourWarehouseId]?.deliveryConfigUuid;
    if (deliveryConfig) {
      // Повтор безпечний: той самий uuid резерву вдруге не відвантажується (BM відповідає 422).
      await run.step('SHIP', { repeatable: true }, async () => {
        const deps = await this.call<{ departures?: unknown[] }>(conn, {
          method: 'GET',
          path: '/processing/departures',
          query: { delivery_config: deliveryConfig, warehouse },
        });
        const list = asArray(deps.departures).map(asRecord);
        const dep = list.find(d => asRecord(d.additional).is_fastest === true) ?? list[0];
        if (!dep)
          throw new SupplierProtocolError(NAME, `${NAME}: немає доступних рейсів для доставки`);
        const r = await this.call<{
          result?: boolean;
          error?: string;
          document?: { number?: string };
        }>(conn, {
          method: 'POST',
          path: '/processing/reserve/process',
          body: {
            orders_array: [run.state.externalOrderId],
            delivery_config: deliveryConfig,
            warehouse,
            key: str(dep.key),
            expired_at: str(dep.expired_at),
            departure_at: str(dep.departure_at),
            ...(str(dep.route_code) ? { route_code: str(dep.route_code) } : {}),
            ...(str(dep.route_at) ? { route_at: str(dep.route_at) } : {}),
            comment: order.reference,
          },
        });
        if (r.result === false)
          throw new SupplierProtocolError(
            NAME,
            `${NAME}: відвантаження відхилено — ${r.error ?? ''}`,
          );
        return { externalNumber: str(r.document?.number) };
      });
    }

    if (!reserve) return { status: 'PLACED', statusRaw: null };
    return { status: 'CONFIRMED', statusRaw: 'reserves', lines: bmReserveLines(reserve) };
  }

  async findOrderByReference(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
  ): Promise<FoundOrder | null> {
    const r = await this.call<Record<string, unknown>>(conn, {
      method: 'GET',
      path: '/shopping/reserves',
    });
    const hit = findBmReserve(r, o => str(o.comment) === order.reference);
    const id = hit ? str(hit.order.uuid) : null;
    return hit && id ? { externalOrderId: id, externalNumber: str(hit.order.number) } : null;
  }

  async getOrderStatus(
    conn: SupplierConnectionContext,
    _order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult> {
    const r = await this.call<Record<string, unknown>>(conn, {
      method: 'GET',
      path: '/shopping/reserves',
    });
    const hit = findBmReserve(r, o => str(o.uuid) === state.externalOrderId);
    if (!hit) return { statusRaw: 'not_listed', status: null };
    return {
      statusRaw: `${hit.branch}:${str(hit.order.status) ?? ''}`,
      status: BM_BRANCH_STATUS[hit.branch] ?? null,
      externalNumber: str(hit.order.number),
    };
  }

  private async call<T>(
    conn: SupplierConnectionContext,
    req: Omit<SupplierHttpRequest, 'provider' | 'baseUrl' | 'headers' | 'secrets' | 'rateScope'>,
  ): Promise<T> {
    const token = requireCredential(conn, 'token', NAME);
    const ua =
      typeof conn.options.userAgent === 'string' && conn.options.userAgent
        ? conn.options.userAgent
        : DEFAULT_USER_AGENT;
    const r = await this.http.request<T>({
      ...req,
      provider: NAME,
      baseUrl: baseUrlOf(conn, BM_PROD_URL),
      headers: {
        Authorization: token,
        'User-Agent': ua,
        ...(conn.testMode ? { 'X-Test-Mode': '1' } : {}),
      },
      secrets: [token],
      rateScope: `bm:${conn.id}`,
    });
    return r.data;
  }
}
