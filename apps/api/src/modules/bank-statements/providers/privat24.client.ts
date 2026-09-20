import { Injectable } from '@nestjs/common';
import { validatePublicUrl } from '../../../common/utils/url-guard';
import { redactSecrets } from '../../../common/utils/redact';

const DEFAULT_BASE = 'https://acp.privatbank.ua/api';
const HTTP_TIMEOUT_MS = 10_000;
// Hard-cap сторінок followId-пагінації (~100 транзакцій/стор). Захист від безкінечного циклу, якщо
// провайдер завжди повертає exist_next_page=true (битий followId / зациклений курсор).
const MAX_PAGES = 200;

/** Параметри витягу транзакцій Privat24 Merchant (Autoclient). */
export interface Privat24FetchArgs {
  apiUrl?: string | null;
  /** id мерчанта (Autoclient) — заголовок `id`. */
  id: string;
  /** token мерчанта (Autoclient) — заголовок `token`. */
  token: string;
  iban: string;
  from: Date;
  to: Date;
}

/** Дата у форматі Privat24 API: DD-MM-YYYY (UTC-стабільно, без TZ-дрейфу). */
function toPrivatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Тонкий клієнт Privat24 Merchant API (statements). Auth — заголовки `id` + `token` (Autoclient).
 * Endpoint GET/POST /statements/transactions, дати DD-MM-YYYY, followId-пагінація (~100/стор).
 * SSRF-guard (validatePublicUrl) + redirect:'manual' + AbortController timeout + reject-3xx +
 * redactSecrets([id,token]). Без webhook — лише pull за вікном дат (offline-first за NAT).
 *
 * MANUAL-VERIFY (на живих даних): (а) метод GET vs POST — деякі версії Privat statements
 * приймають GET з query-параметрами; тут POST з JSON-тілом (звірити на реальному Autoclient);
 * (б) точні назви полів відповіді (REF/OSND/SUM/TRANTYPE) — нормалізація у privat24.provider;
 * (в) сигнатура/HMAC — Autoclient token-режим підписом не потребує (звірити).
 */
@Injectable()
export class Privat24Client {
  /** Витягти сирі транзакції за вікно дат (усі сторінки followId). Повертає сирий масив об'єктів. */
  async fetchTransactions(args: Privat24FetchArgs): Promise<Record<string, unknown>[]> {
    const startDate = toPrivatDate(args.from);
    const endDate = toPrivatDate(args.to);

    const rows: Record<string, unknown>[] = [];
    let followId: string | undefined;
    let page = 0;

    // followId-цикл: поки exist_next_page — тягнемо наступну сторінку за курсором followId.
    while (page < MAX_PAGES) {
      const body: Record<string, unknown> = {
        acc: args.iban,
        startDate,
        endDate,
        ...(followId ? { followId } : {}),
      };
      const res = await this.call(args.apiUrl, body, args.id, args.token);

      // Транзакції можуть лежати у res.transactions (звірити точну назву на живих даних).
      const batch = Array.isArray(res?.transactions)
        ? (res.transactions as Record<string, unknown>[])
        : [];
      rows.push(...batch);

      page += 1;
      // exist_next_page — рядок/булеве «true»; followId — курсор наступної сторінки.
      const hasNext = res?.exist_next_page === true || res?.exist_next_page === 'true';
      const nextFollowId = typeof res?.next_page_id === 'string' ? res.next_page_id : undefined;
      if (!hasNext || !nextFollowId) break;
      followId = nextFollowId;
    }

    return rows;
  }

  /** SSRF-guard + redirect:'manual' + timeout + reject-3xx. POST /statements/transactions. */
  private async call(
    apiUrlRaw: string | null | undefined,
    body: unknown,
    id: string,
    token: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- зовнішній API-response (нормалізація нижче за викликом)
  ): Promise<any> {
    const apiUrl = (apiUrlRaw || DEFAULT_BASE).replace(/\/$/, '');
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний Privat24 API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/statements/transactions`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          id,
          token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Privat24 повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Privat24 ${response.status}: ${redactSecrets(err, [id, token])}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
