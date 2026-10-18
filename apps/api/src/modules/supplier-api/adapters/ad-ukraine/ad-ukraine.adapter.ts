import { Injectable } from '@nestjs/common';
import {
  SupplierAuthSession,
  jwtExpiresAt,
  type AuthTokenState,
} from '../../auth/supplier-auth.session';
import { SupplierHttpClient } from '../../http/supplier-http.client';
import { SupplierAuthError, SupplierProtocolError } from '../../http/supplier-errors';
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
import { adRowToOffers, mapAdOrder, parseAdOfferKey } from './ad-ukraine.mapper';

const NAME = 'AD';
export const AD_PROD_URL = 'https://api.ad.ua';
const API = '/api/v2/ecom';
/** Строк дії токена, якщо в JWT немає `exp` (специфікація строку не називає). */
const TOKEN_FALLBACK_MS = 30 * 60_000;
/** Звірка: скільки сторінок невідвантажених замовлень переглянути. */
const RECONCILE_PAGES = 5;
export const AD_COMPANIES = ['autotechnics', 'cargo-parts', 'forma-parts', 'addiesel'];

/**
 * AD Ukraine / АвтоТехнікс (https://api.ad.ua/swagger/eCom.OpenApi.v2/swagger.json). Логін →
 * JWT (`Authorization: Bearer`), прострочений — повторний логін (refresh-токена немає).
 * Пошук `item/search` за артикулом / OE / внутрішнім номером; замовлення — одним викликом
 * `order/create` на склад AD (`locationCode`) з коментарем-reference; звірка — `order/list`
 * за коментарем.
 */
@Injectable()
export class AdUkraineAdapter implements SupplierAdapter {
  readonly provider = 'AD_UKRAINE' as const;
  readonly name = 'AD Ukraine (АвтоТехнікс)';
  readonly capabilities = {
    search: 'online',
    analogs: false,
    order: 'direct',
    sandbox: false,
    orderPerWarehouse: true,
    requiresWarehouseMapping: false,
  } as const;
  readonly credentialFields = [
    { key: 'login', label: 'Логін', secret: false, required: true, type: 'string' },
    { key: 'pwd', label: 'Пароль', secret: true, required: true, type: 'string' },
  ] as const satisfies SupplierAdapter['credentialFields'];
  readonly optionFields = [
    {
      key: 'company',
      label: 'Компанія',
      secret: false,
      required: false,
      type: 'select',
      options: AD_COMPANIES,
    },
  ] as const satisfies SupplierAdapter['optionFields'];
  readonly warehouseFields = [] as SupplierAdapter['warehouseFields'];
  readonly orderSteps = ['CREATE'] as const;

  constructor(
    private readonly http: SupplierHttpClient,
    private readonly session: SupplierAuthSession,
  ) {}

  async verify(conn: SupplierConnectionContext): Promise<void> {
    await this.session.getToken(conn, this.issuer(conn), true);
    await this.authed(conn, '/location/list', { page: 1 });
  }

  async search(
    conn: SupplierConnectionContext,
    q: SupplierSearchQuery,
  ): Promise<NormalizedOffer[]> {
    const r = await this.authed<{ data?: { rows?: unknown[] } }>(conn, '/item/search', {
      code: q.article,
    });
    const offers = asArray(r.data?.rows).flatMap(row => {
      const rec = asRecord(row);
      const exact =
        (sameArticle(str(rec.itemNo) ?? '', q.article) ||
          sameArticle(str(rec.itemNo2) ?? '', q.article)) &&
        sameBrand(str(rec.brand), q.brand);
      return adRowToOffers(row).map(o => ({ ...o, isAnalog: !exact }));
    });
    return keepValidOffers(offers);
  }

  async placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult> {
    const location =
      order.supplierWarehouseCode ?? parseAdOfferKey(order.lines[0]?.offerKey ?? '').location;
    if (!location)
      throw new SupplierProtocolError(NAME, `${NAME}: замовлення без складу постачальника`);
    await run.step('CREATE', { repeatable: false }, async () => {
      const r = await this.authed<{ data?: { docNo?: string } }>(conn, '/order/create', {
        items: order.lines.map(l => ({
          itemNo: parseAdOfferKey(l.offerKey).itemNo || l.supplierItemId,
          quantity: Math.ceil(l.qty),
        })),
        locationCode: location,
        customerComment: order.reference,
      });
      const docNo = str(r.data?.docNo);
      if (!docNo)
        throw new SupplierProtocolError(NAME, `${NAME}: замовлення без docNo`, null, true);
      return { externalOrderId: docNo, externalNumber: docNo };
    });
    return { status: 'PLACED', statusRaw: null };
  }

  async findOrderByReference(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
  ): Promise<FoundOrder | null> {
    for (let page = 1; page <= RECONCILE_PAGES; page++) {
      const r = await this.authed<{
        data?: { rows?: unknown[]; total?: number; pageSize?: number };
      }>(conn, '/order/list', { page });
      const rows = asArray(r.data?.rows).map(asRecord);
      const hit = rows.find(o => str(o.customerComment) === order.reference);
      const docNo = hit ? str(hit.docNo) : null;
      if (docNo) return { externalOrderId: docNo, externalNumber: docNo };
      const total = Number(r.data?.total ?? 0);
      const size = Number(r.data?.pageSize ?? rows.length);
      if (rows.length === 0 || page * Math.max(size, 1) >= total) break;
    }
    return null;
  }

  async getOrderStatus(
    conn: SupplierConnectionContext,
    _order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult> {
    if (!state.externalOrderId)
      throw new SupplierProtocolError(NAME, `${NAME}: замовлення без docNo`);
    try {
      const r = await this.authed<{ data?: Record<string, unknown> }>(conn, '/order/one', {
        docNo: state.externalOrderId,
      });
      const m = mapAdOrder(asRecord(r.data));
      return { statusRaw: m.statusRaw, status: m.status, lines: m.lines };
    } catch (e) {
      // `order/one` віддає лише НЕвідвантажені: замовлення зникло — найімовірніше відвантажене,
      // але специфікація цього не гарантує; нормалізований статус не змінюємо (звірити наживо).
      if (e instanceof SupplierProtocolError && [400, 404].includes(e.httpStatus ?? 0)) {
        return { statusRaw: 'not_in_unshipped', status: null };
      }
      throw e;
    }
  }

  private issuer(conn: SupplierConnectionContext) {
    const login = requireCredential(conn, 'login', NAME);
    const pwd = requireCredential(conn, 'pwd', NAME);
    const company =
      typeof conn.options.company === 'string' ? conn.options.company : 'autotechnics';
    return {
      login: async (): Promise<AuthTokenState> => {
        const r = await this.http.request<{ data?: { token?: string } }>({
          provider: NAME,
          baseUrl: baseUrlOf(conn, AD_PROD_URL),
          method: 'POST',
          path: `${API}/auth/login`,
          body: { login, pwd, company },
          secrets: [pwd],
          rateScope: `ad:${conn.id}`,
        });
        const token = str(r.data.data?.token);
        if (!token) throw new SupplierAuthError(NAME, `${NAME}: відповідь логіну без токена`);
        return {
          accessToken: token,
          refreshToken: null,
          expiresAt: jwtExpiresAt(token, TOKEN_FALLBACK_MS),
        };
      },
    };
  }

  private authed<T>(conn: SupplierConnectionContext, path: string, body: unknown): Promise<T> {
    return this.session.withToken(conn, this.issuer(conn), async token => {
      const r = await this.http.request<T>({
        provider: NAME,
        baseUrl: baseUrlOf(conn, AD_PROD_URL),
        method: 'POST',
        path: `${API}${path}`,
        body,
        headers: { Authorization: `Bearer ${token}` },
        secrets: [token],
        rateScope: `ad:${conn.id}`,
      });
      return r.data;
    });
  }
}
