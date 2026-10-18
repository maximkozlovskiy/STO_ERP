import { Injectable } from '@nestjs/common';
import { redactSecrets } from '../../../../common/utils/redact';
import { SupplierHttpClient } from '../../http/supplier-http.client';
import {
  ERROR_BODY_MAX,
  SupplierAuthError,
  SupplierProtocolError,
} from '../../http/supplier-errors';
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
  parseTehnomirOfferKey,
  summarizeTehnomirPositions,
  tehnomirProductToOffers,
} from './tehnomir.mapper';

const NAME = 'Tehnomir';
export const TEHNOMIR_PROD_URL = 'https://api.tehnomir.com.ua';
/** `basket/add`: кількість — від 1 до 200 (специфікація). */
const BASKET_MAX_QTY = 200;

const positionRef = (reference: string, index: number) => `${reference}-${index + 1}`;

/**
 * Tehnomir (swagger https://tehnomir.com.ua/index.php?r=swagger%2Fjson-schema). Усі запити —
 * POST JSON, `apiToken` у тілі (тому секрет вирізається з тексту помилок). Ліміт — 503 «Exceeded
 * the allowable limit of requests» (інша 503 — серверна помилка). Замовлення — кошик: позиції додаються з нашим `reference`
 * на кожну («<reference>-<№>»), повторне додавання не дублює (спершу `basket/getPositions`), а
 * `order/create` оформлює ЛИШЕ перелічені `basketIds` — чужі позиції кошика акаунта не
 * замовляються. Звірка — `order/search` за `orderNumber` = reference.
 */
@Injectable()
export class TehnomirAdapter implements SupplierAdapter {
  readonly provider = 'TEHNOMIR' as const;
  readonly name = 'Tehnomir';
  readonly capabilities = {
    search: 'online',
    analogs: true,
    order: 'cart',
    sandbox: false,
    orderPerWarehouse: false,
    requiresWarehouseMapping: false,
  } as const;
  readonly credentialFields = [
    {
      key: 'apiToken',
      label: 'API-токен (Управління → API)',
      secret: true,
      required: true,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['credentialFields'];
  readonly optionFields = [] as SupplierAdapter['optionFields'];
  readonly warehouseFields = [] as SupplierAdapter['warehouseFields'];
  readonly orderSteps = ['BASKET', 'ORDER'] as const;

  constructor(private readonly http: SupplierHttpClient) {}

  async verify(conn: SupplierConnectionContext): Promise<void> {
    const r = await this.call<{ data?: { testString?: string } }>(conn, '/test/connect', {
      string: 'sto-erp',
    });
    if (r.data?.testString !== undefined && r.data.testString !== 'sto-erp') {
      throw new SupplierProtocolError(NAME, `${NAME}: неочікувана відповідь /test/connect`);
    }
  }

  async search(
    conn: SupplierConnectionContext,
    q: SupplierSearchQuery,
  ): Promise<NormalizedOffer[]> {
    const r = await this.call<{ data?: unknown[] }>(conn, '/price/search', {
      code: q.article,
      isShowAnalogs: q.includeAnalogs ? 1 : 0,
    });
    const offers = asArray(r.data).flatMap(p => {
      const rec = asRecord(p);
      const exact =
        sameArticle(str(rec.code) ?? '', q.article) && sameBrand(str(rec.brand), q.brand);
      return tehnomirProductToOffers(p).map(o => ({ ...o, isAnalog: !exact }));
    });
    return keepValidOffers(offers);
  }

  async placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult> {
    await run.step('BASKET', { repeatable: true }, async () => {
      const existing = await this.basketByReference(conn);
      for (const [i, line] of order.lines.entries()) {
        const ref = positionRef(order.reference, i);
        if (existing.has(ref)) continue;
        const key = parseTehnomirOfferKey(line.offerKey);
        const qty = Math.ceil(line.qty);
        if (qty > BASKET_MAX_QTY) {
          throw new SupplierProtocolError(
            NAME,
            `${NAME}: кількість понад ${BASKET_MAX_QTY} в одній позиції`,
          );
        }
        await this.call(conn, '/basket/add', {
          productId: key.productId,
          priceLogo: key.priceLogo,
          quantity: qty,
          reference: ref,
          comment: order.purchaseOrderNumber,
        });
      }
    });

    let created: Record<string, unknown> | null = null;
    if (run.state.step !== 'ORDER') {
      // Читання до неповторюваного кроку: його збій безпечно повторити.
      const basket = await this.basketByReference(conn);
      const basketIds = order.lines.map((_, i) => basket.get(positionRef(order.reference, i)));
      if (basketIds.some(id => id === undefined)) {
        throw new SupplierProtocolError(
          NAME,
          `${NAME}: позицій замовлення немає в кошику — повтор`,
        );
      }
      await run.step('ORDER', { repeatable: false }, async () => {
        const r = await this.call<{ data?: Record<string, unknown> }>(conn, '/order/create', {
          orderNumber: order.reference,
          basketIds,
        });
        created = asRecord(r.data);
        const id = str(created.orderId);
        if (!id)
          throw new SupplierProtocolError(NAME, `${NAME}: замовлення без orderId`, null, true);
        return { externalOrderId: id, externalNumber: id };
      });
    }
    const c = created as Record<string, unknown> | null;
    return { status: 'PLACED', statusRaw: c ? str(c.status) : null };
  }

  async findOrderByReference(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
  ): Promise<FoundOrder | null> {
    const r = await this.call<{ data?: unknown[] }>(conn, '/order/search', {
      orderNumber: order.reference,
    });
    const hit = asArray(r.data)
      .map(asRecord)
      .find(o => str(o.orderNumber) === order.reference);
    const id = hit ? str(hit.orderId) : null;
    return id ? { externalOrderId: id, externalNumber: id } : null;
  }

  async getOrderStatus(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult> {
    if (!state.externalOrderId)
      throw new SupplierProtocolError(NAME, `${NAME}: замовлення без orderId`);
    const r = await this.call<{ data?: unknown[] }>(conn, '/order/getOrderPositions', {
      orderId: Number(state.externalOrderId),
    });
    const byRef = new Map(
      order.lines.map((l, i) => [
        positionRef(order.reference, i),
        { supplierItemId: l.supplierItemId, warehouseCode: l.warehouseCode },
      ]),
    );
    const s = summarizeTehnomirPositions(asArray(r.data), byRef);
    return { statusRaw: s.statusRaw, status: s.status, lines: s.lines };
  }

  /** Позиції кошика акаунта: наш reference → basketId. */
  private async basketByReference(conn: SupplierConnectionContext): Promise<Map<string, number>> {
    const r = await this.call<{ data?: unknown[] }>(conn, '/basket/getPositions', {});
    const map = new Map<string, number>();
    for (const p of asArray(r.data).map(asRecord)) {
      const ref = str(p.reference);
      const id = Number(p.basketId);
      if (ref && Number.isFinite(id)) map.set(ref, id);
    }
    return map;
  }

  private async call<T = unknown>(
    conn: SupplierConnectionContext,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const apiToken = requireCredential(conn, 'apiToken', NAME);
    const r = await this.http.request<T & { success?: boolean; message?: string }>({
      provider: NAME,
      baseUrl: baseUrlOf(conn, TEHNOMIR_PROD_URL),
      method: 'POST',
      path,
      body: { apiToken, ...body },
      secrets: [apiToken],
      rateScope: `tehnomir:${conn.id}`,
      // 503 — ліміт лише з «Exceeded the allowable limit…» у тілі; інша 503 — серверна (неоднозначна).
      rateLimitStatuses: [503],
      rateLimitBodyPattern: /limit/i,
    });
    if (r.data.success === false) {
      // Тіло 2xx не проходить redactSecrets клієнта, а токен іде в тілі запиту — постачальник міг
      // віддзеркалити його в message (BR-SCON-002).
      const reason = redactSecrets(str(r.data.message) ?? 'success=false', [apiToken]);
      const msg = `${NAME} ${r.status}: ${reason.slice(0, ERROR_BODY_MAX)}`;
      if (/token|токен/i.test(msg)) throw new SupplierAuthError(NAME, msg, r.status);
      throw new SupplierProtocolError(NAME, msg, r.status);
    }
    return r.data;
  }
}
