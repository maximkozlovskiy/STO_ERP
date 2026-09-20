import { Injectable } from '@nestjs/common';
import { validatePublicUrl } from '../../../common/utils/url-guard';
import { redactSecrets } from '../../../common/utils/redact';

const DEFAULT_BASE = 'https://api.monobank.ua';
const HTTP_TIMEOUT_MS = 10_000;
// monobank statement API: макс вікно 31 день + 1 год на запит. Розбиваємо [from,to] на ≤31-денні
// шматки (WINDOWING). Беремо консервативні 31 день рівно (без +1 год) — простіше і безпечніше.
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
// Hard-cap кількості вікон проти нескінченного циклу (битий from/to). ~12 вікон = ~1 рік backfill.
const MAX_WINDOWS = 12;
// Rate-limit monobank: 1 запит / 60 с. Пауза МІЖ шматками (лише backfill із >1 вікном). Це
// BullMQ-воркер (offline-first) — блокуюча пауза у ВОРКЕРІ прийнятна, не у request-шляху.
const RATE_LIMIT_MS = 60_000;

/** Одна проводка виписки monobank (personal statement). amount — у МІНОР-одиницях (копійки). */
export interface StatementItem {
  /** Унікальний id проводки (→ externalId). */
  id: string;
  /** Час проводки — Unix timestamp у СЕКУНДАХ. */
  time: number;
  /** Сума у МІНОР-одиницях: +credit (вхідні) / −debit. ДІЛИТИ на 100 для гривень! */
  amount: number;
  currencyCode?: number;
  comment?: string;
  counterName?: string;
  counterIban?: string;
  counterEdrpou?: string;
  description?: string;
}

/** Параметри витягу виписки monobank. account = mono account id (НЕ IBAN); дефолт '0'. */
export interface MonoStatementFetchArgs {
  apiUrl?: string | null;
  /** Персональний X-Token (web.monobank.ua/?modal=tokens) — заголовок `X-Token`. */
  token: string;
  /** mono account id (НЕ IBAN). MVP — з креденшелу accountId, дефолт '0'. */
  account: string;
  from: Date;
  to: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Тонкий клієнт monobank personal statement API. Auth — заголовок X-Token (персональний токен,
 * НЕ еквайринговий — тому окремий клієнт, payments/monobank.client НЕ чіпаємо).
 * Endpoint GET /personal/statement/{account}/{unixFrom}/{unixTo} (from/to — Unix СЕКУНДИ).
 * SSRF-guard (validatePublicUrl) + redirect:'manual' + AbortController timeout + reject-3xx +
 * redactSecrets([token]). WINDOWING (≤31 день/запит) + rate-limit пауза між шматками (backfill).
 *
 * MANUAL-VERIFY (на живих даних): (а) резолв {account} — mono account id, не IBAN; MVP бере
 * дефолт '0' (перший рахунок) — звірити на реальному токені зі списком рахунків (client-info);
 * (б) точний rate-limit (1/60с) і чи +1 год до 31 дня дозволено — тут консервативно 31 день рівно;
 * (в) точні назви полів (counterName/counterIban/counterEdrpou) — нормалізація у provider.mapTx.
 */
@Injectable()
export class MonoStatementClient {
  /** Витягти проводки за вікно дат (WINDOWING по ≤31 день). Повертає сирий масив StatementItem. */
  async fetchStatements(args: MonoStatementFetchArgs): Promise<StatementItem[]> {
    const windows = this.splitWindows(args.from, args.to);
    const out: StatementItem[] = [];
    for (let i = 0; i < windows.length; i++) {
      // Rate-limit: пауза ПЕРЕД кожним запитом після першого (лише backfill із >1 вікном).
      if (i > 0) await sleep(RATE_LIMIT_MS);
      const w = windows[i]!;
      const fromSec = Math.floor(w.from.getTime() / 1000);
      const toSec = Math.floor(w.to.getTime() / 1000);
      const batch = await this.call(args.apiUrl, args.account, fromSec, toSec, args.token);
      out.push(...batch);
    }
    return out;
  }

  /** Розбити [from,to] на ≤31-денні шматки (WINDOWING). Cap MAX_WINDOWS проти нескінченного циклу. */
  private splitWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
    const windows: Array<{ from: Date; to: Date }> = [];
    let cursor = from.getTime();
    const end = to.getTime();
    // Захист від інвертованого діапазону (from >= to) → одне порожнє вікно [from, from].
    if (cursor >= end) return [{ from, to }];
    while (cursor < end && windows.length < MAX_WINDOWS) {
      const chunkEnd = Math.min(cursor + WINDOW_MS, end);
      windows.push({ from: new Date(cursor), to: new Date(chunkEnd) });
      cursor = chunkEnd;
    }
    return windows;
  }

  /** SSRF-guard + redirect:'manual' + timeout + reject-3xx. GET /personal/statement/{acc}/{from}/{to}. */
  private async call(
    apiUrlRaw: string | null | undefined,
    account: string,
    fromSec: number,
    toSec: number,
    token: string,
  ): Promise<StatementItem[]> {
    const apiUrl = (apiUrlRaw || DEFAULT_BASE).replace(/\/$/, '');
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний monobank API URL: ${urlError}`);

    const path = `/personal/statement/${encodeURIComponent(account)}/${fromSec}/${toSec}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': token,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`monobank повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`monobank ${response.status}: ${redactSecrets(err, [token])}`);
    }
    const text = await response.text();
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    // monobank statement → масив StatementItem. Не-масив (напр. {errorDescription}) → 0 проводок.
    return Array.isArray(parsed) ? (parsed as StatementItem[]) : [];
  }
}
