import { Injectable } from '@nestjs/common';
import {
  SupplierAuthSession,
  jwtExpiresAt,
  type AuthTokenState,
} from '../../auth/supplier-auth.session';
import { SupplierHttpClient, type SupplierHttpRequest } from '../../http/supplier-http.client';
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
  warehouseOptions,
} from '../adapter-utils';
import { kyivYmd } from '../../../../common/utils/kyiv-date';
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
  mapUtrStatus,
  parseUtrOfferKey,
  utrDetailToOffers,
  utrExpiresAt,
  utrOrderLines,
} from './utr.mapper';

const NAME = 'UTR';
export const UTR_PROD_URL = 'https://order24-api.utr.ua';
/** Запасний строк дії токена, якщо ні JWT exp, ні expires_at не розібрано. */
const TOKEN_FALLBACK_MS = 50 * 60_000;
/** Звірка: замовлення за останні 2 дні (оформлення біля опівночі). */
const RECONCILE_LOOKBACK_MS = 2 * 86_400_000;

/**
 * UTR / UniqTrade API v2 (https://api.utr.ua). Логін `POST /api/login_check?browser_fingerprint=`
 * → JWT із `expires_at` і refresh-токеном; `POST /api/token/refresh` (той самий fingerprint).
 * Пошук `GET /api/search/{oem}?brand=`; замовлення — одним викликом `POST /api/order/accept` з
 * коментарем-reference після вибору варіанту доставки (`POST /api/deliveries/{date}/{point}/{transporter}`);
 * звірка — `GET /api/order-list/{date}` за коментарем.
 */
@Injectable()
export class UtrAdapter implements SupplierAdapter {
  readonly provider = 'UTR' as const;
  readonly name = 'UTR (UniqTrade)';
  readonly capabilities = {
    search: 'online',
    analogs: false,
    order: 'direct',
    sandbox: false,
    orderPerWarehouse: false,
    requiresWarehouseMapping: true,
  } as const;
  readonly credentialFields = [
    { key: 'email', label: 'Логін (email)', secret: false, required: true, type: 'string' },
    { key: 'password', label: 'Пароль', secret: true, required: true, type: 'string' },
  ] as const satisfies SupplierAdapter['credentialFields'];
  readonly optionFields = [
    {
      key: 'paymentType',
      label: 'Оплата (nal — готівка, beznal — безготівково)',
      secret: false,
      required: false,
      type: 'select',
      options: ['beznal', 'nal'],
    },
  ] as const satisfies SupplierAdapter['optionFields'];
  readonly warehouseFields = [
    {
      key: 'deliveryPointId',
      label: 'Точка доставки UTR (GET /api/delivery-points)',
      secret: false,
      required: true,
      type: 'string',
    },
    {
      key: 'transporterId',
      label: 'Перевізник UTR (отримання перевізників)',
      secret: false,
      required: true,
      type: 'string',
    },
  ] as const satisfies SupplierAdapter['warehouseFields'];
  readonly orderSteps = ['ACCEPT'] as const;

  constructor(
    private readonly http: SupplierHttpClient,
    private readonly session: SupplierAuthSession,
  ) {}

  async verify(conn: SupplierConnectionContext): Promise<void> {
    await this.session.getToken(conn, this.issuer(conn), true);
    await this.authed(conn, { method: 'GET', path: '/api/delivery-points' });
  }

  async search(
    conn: SupplierConnectionContext,
    q: SupplierSearchQuery,
  ): Promise<NormalizedOffer[]> {
    const r = await this.authed<{ details?: unknown[] }>(conn, {
      method: 'GET',
      path: `/api/search/${encodeURIComponent(q.article)}`,
      query: { brand: q.brand ?? undefined },
    });
    const offers = asArray(r.details).flatMap(utrDetailToOffers);
    return keepValidOffers(
      offers.map(o => ({
        ...o,
        isAnalog: !sameArticle(o.article, q.article) || !sameBrand(o.brand, q.brand),
      })),
    );
  }

  async placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult> {
    const wh = warehouseOptions(conn, order.ourWarehouseId, NAME);
    const items = order.lines.map(l => {
      const key = parseUtrOfferKey(l.offerKey);
      return { detail: key.detailId, quantity: Math.ceil(l.qty), storage: key.storageId };
    });
    let accepted: Record<string, unknown> | null = null;
    if (run.state.step !== 'ACCEPT') {
      const date = kyivYmd(new Date());
      // Варіант доставки — читання до неповторюваного кроку: його збій безпечно повторити.
      const variants = await this.authed<unknown[]>(conn, {
        method: 'POST',
        path: `/api/deliveries/${date}/${wh.deliveryPointId}/${wh.transporterId}`,
        body: { storages: [...new Set(items.map(i => i.storage))] },
      });
      const variant = asArray(variants)
        .map(asRecord)
        .find(v => Number(v.id) > 0);
      if (!variant) {
        throw new SupplierProtocolError(
          NAME,
          `${NAME}: на сьогодні немає варіантів доставки зі складів замовлення`,
        );
      }
      // Токен — до неповторюваного кроку: тайм-аут логіну всередині кроку дав би хибну звірку.
      const issuer = this.issuer(conn);
      const token = await this.session.getToken(conn, issuer, false);
      const accept = (bearer: string) =>
        run.step('ACCEPT', { repeatable: false }, async () => {
          const r = await this.withBearer<unknown[]>(conn, bearer, {
            method: 'POST',
            path: '/api/order/accept',
            body: [
              {
                comment: order.reference,
                delivery: Number(variant.id),
                deliveryDate: date,
                deliveryPoint: Number(wh.deliveryPointId),
                items,
                paymentType: (conn.options.paymentType as string | undefined) ?? 'beznal',
                withoutDocument: false,
              },
            ],
          });
          accepted = asRecord(asArray(r)[0]);
          const id = str(accepted.id);
          if (!id) throw new SupplierProtocolError(NAME, `${NAME}: замовлення без id`, null, true);
          return { externalOrderId: id, externalNumber: str(accepted.externalCode) };
        });
      try {
        await accept(token);
      } catch (e) {
        // 401/403 — виклик відхилено до виконання (крок повернуто); новий токен — поза кроком.
        if (!(e instanceof SupplierAuthError)) throw e;
        await accept(await this.session.getToken(conn, issuer, true, token));
      }
    }
    if (!accepted) return { status: 'PLACED', statusRaw: null };
    const o = accepted as Record<string, unknown>;
    const raw = str(o.status);
    return { status: mapUtrStatus(raw) ?? 'PLACED', statusRaw: raw, lines: utrOrderLines(o) };
  }

  async findOrderByReference(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
  ): Promise<FoundOrder | null> {
    const from = kyivYmd(new Date((order.sentAt ?? new Date()).getTime() - RECONCILE_LOOKBACK_MS));
    const list = await this.authed<unknown[]>(conn, {
      method: 'GET',
      path: `/api/order-list/${from}`,
      query: { page: 1, limit: 100, mode: 'period' },
    });
    const found = asArray(list)
      .map(asRecord)
      .find(o => str(o.comment) === order.reference);
    const id = found ? str(found.id) : null;
    return found && id ? { externalOrderId: id, externalNumber: str(found.externalCode) } : null;
  }

  async getOrderStatus(
    conn: SupplierConnectionContext,
    _order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult> {
    if (!state.externalOrderId) throw new SupplierProtocolError(NAME, `${NAME}: замовлення без id`);
    const o = asRecord(
      await this.authed(conn, { method: 'GET', path: `/api/order/${state.externalOrderId}` }),
    );
    const raw = str(o.status) ?? '';
    return {
      statusRaw: raw,
      status: mapUtrStatus(raw),
      externalNumber: str(o.externalCode),
      lines: utrOrderLines(o),
    };
  }

  // ─── Авторизація ──────────────────────────────────────────

  private fingerprint(conn: SupplierConnectionContext): string {
    // Будь-який унікальний рядок ≤ 128 символів, однаковий для логіну й оновлення (документація).
    return `sto-erp-${conn.id}`;
  }

  private issuer(conn: SupplierConnectionContext) {
    const email = requireCredential(conn, 'email', NAME);
    const password = requireCredential(conn, 'password', NAME);
    const toState = (b: Record<string, unknown>): AuthTokenState => {
      const token = str(b.token);
      if (!token) throw new SupplierAuthError(NAME, `${NAME}: відповідь логіну без токена`);
      return {
        accessToken: token,
        refreshToken: str(b.refresh_token),
        expiresAt: utrExpiresAt(b.expires_at) ?? jwtExpiresAt(token, TOKEN_FALLBACK_MS),
      };
    };
    const base = baseUrlOf(conn, UTR_PROD_URL);
    return {
      login: async () => {
        try {
          const r = await this.http.request<Record<string, unknown>>({
            provider: NAME,
            baseUrl: base,
            method: 'POST',
            path: '/api/login_check',
            query: { browser_fingerprint: this.fingerprint(conn) },
            body: { email, password },
            secrets: [password],
            rateScope: `utr:${conn.id}`,
          });
          return toState(r.data);
        } catch (e) {
          // 412 Precondition Failed — «Некоректні дані користувача» (невірний логін чи пароль).
          if (e instanceof SupplierProtocolError && e.httpStatus === 412) {
            throw new SupplierAuthError(NAME, e.message, 412);
          }
          throw e;
        }
      },
      refresh: async (s: AuthTokenState) => {
        const r = await this.http.request<Record<string, unknown>>({
          provider: NAME,
          baseUrl: base,
          method: 'POST',
          path: '/api/token/refresh',
          body: { refresh_token: s.refreshToken, browser_fingerprint: this.fingerprint(conn) },
          secrets: [s.refreshToken],
          rateScope: `utr:${conn.id}`,
        });
        return toState(r.data);
      },
    };
  }

  private authed<T>(conn: SupplierConnectionContext, req: UtrRequest): Promise<T> {
    return this.session.authedRequest<T>(this.http, conn, this.issuer(conn), utrReq(conn, req));
  }

  /** Запит із готовим токеном, без повторної авторизації (для неповторюваного кроку). */
  private withBearer<T>(
    conn: SupplierConnectionContext,
    token: string,
    req: UtrRequest,
  ): Promise<T> {
    return this.session.bearerRequest<T>(this.http, token, utrReq(conn, req));
  }
}

type UtrRequest = Omit<
  SupplierHttpRequest,
  'provider' | 'baseUrl' | 'headers' | 'secrets' | 'rateScope'
>;

const utrReq = (conn: SupplierConnectionContext, req: UtrRequest): SupplierHttpRequest => ({
  ...req,
  provider: NAME,
  baseUrl: baseUrlOf(conn, UTR_PROD_URL),
  rateScope: `utr:${conn.id}`,
});
