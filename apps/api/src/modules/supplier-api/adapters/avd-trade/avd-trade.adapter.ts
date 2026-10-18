import { Injectable } from '@nestjs/common';
import { SupplierHttpClient, type SupplierHttpRequest } from '../../http/supplier-http.client';
import { SupplierNetworkError, SupplierProtocolError } from '../../http/supplier-errors';
import {
  asArray,
  asRecord,
  baseUrlOf,
  requireCredential,
  str,
  warehouseOptions,
} from '../adapter-utils';
import type {
  CatalogMirrorRow,
  CatalogSink,
  FoundOrder,
  NormalizedOffer,
  PlacedOrderResult,
  PlaceOrderRunner,
  SupplierAdapter,
  SupplierConnectionContext,
  SupplierOrderInput,
  SupplierOrderState,
  SupplierOrderStatusResult,
} from '../supplier-adapter.interface';
import {
  avdCheckoutLines,
  avdItemToMirror,
  avdOrderLines,
  mapAvdStatus,
  parseAvdOfferKey,
  parseAvdPriceCsv,
} from './avd-trade.mapper';

const NAME = 'AVD';
export const AVD_PROD_URL = 'https://api.avdtrade.com.ua/api/v1';
export const AVD_DEV_URL = 'https://dev-api.avdtrade.com.ua/api/v1';
/** `items/query`: page ≤ 100, per_page ≤ 5000 (специфікація). */
const PAGE_SIZE = 5000;
const MAX_PAGES = 100;
/** `price/export`: «202 — зачекати 30 секунд і повторити». */
const EXPORT_POLL_ATTEMPTS = 20;
/** Межа файлу прайсу (типова межа відповіді клієнта — 20 МБ, прайс більший). */
const PRICE_FILE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * AVD Trade (https://dev-api.avdtrade.com.ua/openapi.yaml). Ключ — заголовок `x-api-key`; квота
 * спільна для всіх ключів клієнта (`x-ratelimit-*`, 429). Пошуку за артикулом API НЕ має — пошук
 * іде по дзеркалу каталогу (`syncCatalog` → SupplierCatalogItem, BR-SCON-015). Замовлення —
 * кошик: створити (торгова точка) → коментар-reference → рядки `operation: 'replace'` →
 * оформлення. Кошик успадковує uuid у замовлення, тож звірка — `GET /orders?order_uuid=<кошик>`.
 */
@Injectable()
export class AvdTradeAdapter implements SupplierAdapter {
  readonly provider = 'AVD_TRADE' as const;
  readonly name = 'AVD Trade';
  readonly capabilities = {
    search: 'mirror',
    analogs: false,
    order: 'cart',
    sandbox: true,
    orderPerWarehouse: false,
    requiresWarehouseMapping: true,
  } as const;
  readonly credentialFields = [
    { key: 'apiKey', label: 'API-ключ (x-api-key)', secret: true, required: true, type: 'string' },
  ] as const satisfies SupplierAdapter['credentialFields'];
  readonly optionFields = [] as SupplierAdapter['optionFields'];
  readonly warehouseFields = [
    {
      key: 'locationUuid',
      label: 'Торгова точка AVD (GET /locations)',
      secret: false,
      required: true,
      type: 'string',
    },
    {
      key: 'forwarderUuid',
      label: 'Перевізник AVD (GET /forwarders)',
      secret: false,
      required: true,
      type: 'string',
    },
    {
      key: 'recipientUuid',
      label: 'Отримувач (GET /recipients; порожньо — за замовчуванням)',
      secret: false,
      required: false,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['warehouseFields'];
  readonly orderSteps = ['CART', 'COMMENT', 'LINES', 'CHECKOUT'] as const;

  /** Пауза між опитуваннями файлу прайсу (мс); тести ставлять 0. */
  exportPollMs = 30_000;

  constructor(private readonly http: SupplierHttpClient) {}

  async verify(conn: SupplierConnectionContext): Promise<void> {
    const r = await this.call<{ data?: { warehouses?: unknown[] } }>(conn, {
      method: 'GET',
      path: '/warehouses',
    });
    if (!Array.isArray(r.data.data?.warehouses)) {
      throw new SupplierProtocolError(NAME, `${NAME}: неочікувана відповідь /warehouses`);
    }
  }

  search(): Promise<NormalizedOffer[]> {
    // capabilities.search = 'mirror': пропозиції AVD бере SupplierCatalogService з дзеркала.
    return Promise.reject(
      new SupplierProtocolError(
        NAME,
        `${NAME}: пошук за артикулом API не підтримує — лише дзеркало`,
      ),
    );
  }

  async syncCatalog(
    conn: SupplierConnectionContext,
    sink: CatalogSink,
  ): Promise<{ count: number }> {
    try {
      return await this.syncByQuery(conn, sink);
    } catch (e) {
      // `items/query` вимкнено/недоступний для ключа — запасний шлях: асинхронний прайс.
      if (e instanceof SupplierProtocolError && [404, 405, 410].includes(e.httpStatus ?? 0)) {
        return this.syncByExport(conn, sink);
      }
      throw e;
    }
  }

  private async syncByQuery(conn: SupplierConnectionContext, sink: CatalogSink) {
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.call<{
        data?: { items?: unknown[]; pagination?: { total_pages?: number } };
      }>(conn, {
        method: 'POST',
        path: '/items/query',
        body: { page, per_page: PAGE_SIZE, has_stock: true },
        timeoutMs: 120_000,
      });
      const rows = asArray(r.data.data?.items)
        .map(avdItemToMirror)
        .filter((x): x is CatalogMirrorRow => x !== null);
      if (rows.length) await sink.upsert(rows);
      count += rows.length;
      const total = Number(r.data.data?.pagination?.total_pages ?? page);
      if (page >= total || rows.length === 0) break;
    }
    return { count };
  }

  private async syncByExport(conn: SupplierConnectionContext, sink: CatalogSink) {
    const r = await this.call<{ data?: { download_url?: string } }>(conn, {
      method: 'GET',
      path: '/price/export',
    });
    const url = r.data.data?.download_url;
    if (!url) throw new SupplierProtocolError(NAME, `${NAME}: /price/export без download_url`);
    const warehouses = await this.warehouseUuidByName(conn);
    for (let attempt = 0; attempt < EXPORT_POLL_ATTEMPTS; attempt++) {
      const file = await this.call<string>(conn, {
        method: 'GET',
        path: '',
        absoluteUrl: url,
        responseType: 'text',
        timeoutMs: 300_000,
        maxBodyBytes: PRICE_FILE_MAX_BYTES,
      });
      if (file.status === 202) {
        if (this.exportPollMs > 0) await new Promise(res => setTimeout(res, this.exportPollMs));
        continue;
      }
      const rows = parseAvdPriceCsv(file.data).map(row => ({
        ...row,
        stock: row.stock.map(s => ({
          ...s,
          warehouseCode: warehouses.get(s.warehouseCode.toUpperCase()) ?? s.warehouseCode,
        })),
      }));
      for (let i = 0; i < rows.length; i += PAGE_SIZE)
        await sink.upsert(rows.slice(i, i + PAGE_SIZE));
      return { count: rows.length };
    }
    throw new SupplierNetworkError(
      NAME,
      `${NAME}: прайс-лист ще формується — повтор пізніше`,
      false,
    );
  }

  private async warehouseUuidByName(conn: SupplierConnectionContext): Promise<Map<string, string>> {
    const r = await this.call<{ data?: { warehouses?: unknown[] } }>(conn, {
      method: 'GET',
      path: '/warehouses',
    });
    const map = new Map<string, string>();
    for (const w of asArray(r.data.data?.warehouses)) {
      const rec = asRecord(w);
      const uuid = str(rec.uuid);
      const name = str(rec.name);
      if (uuid && name) map.set(name.toUpperCase(), uuid);
    }
    return map;
  }

  async placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult> {
    const wh = warehouseOptions(conn, order.ourWarehouseId, NAME);
    let checkout: Record<string, unknown> | null = null;

    await run.step('CART', { repeatable: true }, async () => {
      const r = await this.call<{ data?: { cart?: { uuid?: string } } }>(conn, {
        method: 'POST',
        path: '/carts',
        body: { location_uuid: wh.locationUuid },
      });
      const uuid = r.data.data?.cart?.uuid;
      if (!uuid)
        throw new SupplierProtocolError(NAME, `${NAME}: кошик створено без uuid`, null, true);
      // externalOrderId — лише після оформлення: зовнішній id = «замовлення в постачальника вже
      // є» (BR-SCON-014), а кошик без checkout замовленням не є.
      return { externalCartId: uuid };
    });
    const cart = run.state.externalCartId as string;

    await run.step('COMMENT', { repeatable: true }, async () => {
      await this.call(conn, {
        method: 'PATCH',
        path: `/carts/${cart}`,
        body: { customer_comment: order.reference },
      });
    });

    await run.step('LINES', { repeatable: true }, async () => {
      // `replace` — повтор кроку не подвоює кількості (BR-SCON-011).
      const r = await this.call<{ data?: { summary?: { success?: number; adjusted?: number } } }>(
        conn,
        {
          method: 'POST',
          path: `/carts/${cart}/lines`,
          body: {
            operation: 'replace',
            lines: order.lines.map(l => {
              const key = parseAvdOfferKey(l.offerKey);
              return {
                item_uuid: key.itemUuid || l.supplierItemId,
                warehouse_uuid: key.warehouseUuid || l.warehouseCode,
                quantity: Math.ceil(l.qty),
              };
            }),
          },
        },
      );
      const s = r.data.data?.summary;
      if (s && (Number(s.success) || 0) + (Number(s.adjusted) || 0) === 0) {
        throw new SupplierProtocolError(
          NAME,
          `${NAME}: жоден рядок не додано в кошик — немає залишку`,
        );
      }
    });

    await run.step('CHECKOUT', { repeatable: false }, async () => {
      const r = await this.call<{ data?: Record<string, unknown> }>(conn, {
        method: 'POST',
        path: `/carts/${cart}/checkout`,
        body: {
          delivery_mode: 'fastest_delivery',
          forwarder_uuid: wh.forwarderUuid,
          ...(wh.recipientUuid ? { recipient_uuid: wh.recipientUuid } : {}),
        },
      });
      checkout = r.data.data ?? {};
      return { externalOrderId: cart };
    });

    if (!checkout) return { status: 'PLACED', statusRaw: null };
    const data = checkout as Record<string, unknown>;
    const processing = asRecord(data.processing);
    const statusRaw = str(processing.status);
    // direct_shipment — замовлення оформлено й забезпечено залишками; shipment_request — розглядає
    // менеджер (кредитний ліміт), підтвердження ще немає. Інший чи відсутній flow — не вгадуємо:
    // PLACED, підтвердження покаже опитування статусу.
    if (str(processing.flow) !== 'direct_shipment') return { status: 'PLACED', statusRaw };
    return { status: 'CONFIRMED', statusRaw, lines: avdCheckoutLines(data) };
  }

  async findOrderByReference(
    conn: SupplierConnectionContext,
    _order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<FoundOrder | null> {
    const cart = state.externalCartId;
    if (!cart) return null;
    const order = await this.fetchOrder(conn, cart);
    if (order) return { externalOrderId: cart, externalNumber: str(order.number) };
    // Перевищено кредитний ліміт — замість замовлення кошик у статусі «Запит на відвантаження».
    const c = await this.fetchCart(conn, cart);
    if (c && mapAvdStatus(str(c.status)) === 'PLACED') {
      return { externalOrderId: cart, externalNumber: str(c.number) };
    }
    return null;
  }

  async getOrderStatus(
    conn: SupplierConnectionContext,
    _order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult> {
    const id = state.externalOrderId ?? state.externalCartId;
    if (!id) throw new SupplierProtocolError(NAME, `${NAME}: замовлення без uuid`);
    const o = await this.fetchOrder(conn, id);
    if (o) {
      const raw = str(o.status) ?? '';
      return {
        statusRaw: raw,
        status: mapAvdStatus(raw),
        externalNumber: str(o.number),
        lines: avdOrderLines(o),
      };
    }
    const c = await this.fetchCart(conn, id);
    const raw = str(c?.status) ?? 'not_found';
    return { statusRaw: raw, status: mapAvdStatus(raw), externalNumber: str(c?.number) };
  }

  private async fetchOrder(conn: SupplierConnectionContext, uuid: string) {
    const r = await this.call<{ data?: { orders?: unknown[] } }>(conn, {
      method: 'GET',
      path: '/orders',
      query: { order_uuid: uuid, include_lines: true },
    });
    const found = asArray(r.data.data?.orders)
      .map(asRecord)
      .find(o => str(o.uuid) === uuid);
    return found ?? null;
  }

  private async fetchCart(conn: SupplierConnectionContext, uuid: string) {
    try {
      const r = await this.call<{ data?: { cart?: unknown } }>(conn, {
        method: 'GET',
        path: `/carts/${uuid}/lines`,
      });
      return asRecord(r.data.data?.cart);
    } catch (e) {
      if (e instanceof SupplierProtocolError && e.httpStatus === 404) return null;
      throw e;
    }
  }

  private call<T>(
    conn: SupplierConnectionContext,
    req: Omit<SupplierHttpRequest, 'provider' | 'baseUrl' | 'headers' | 'secrets' | 'rateScope'>,
  ) {
    const apiKey = requireCredential(conn, 'apiKey', NAME);
    const baseUrl = baseUrlOf(conn, AVD_PROD_URL, AVD_DEV_URL);
    // Посилання на файл прайсу може вести на інший хост — ключ туди не надсилаємо.
    const sameOrigin = !req.absoluteUrl || originOf(req.absoluteUrl) === originOf(baseUrl);
    return this.http.request<T>({
      ...req,
      provider: NAME,
      baseUrl,
      headers: sameOrigin ? { 'x-api-key': apiKey } : {},
      secrets: [apiKey],
      // Квота AVD спільна для всіх ключів клієнта — область на контрагента (BR-SCON-007).
      rateScope: `avd:${conn.orgId}:${conn.counterpartyId}`,
    });
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
