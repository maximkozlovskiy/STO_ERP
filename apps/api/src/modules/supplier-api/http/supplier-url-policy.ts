import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validatePublicUrl } from '../../../common/utils/url-guard';

/** Усі адреси імені (`dns.promises.lookup(host, { all: true })`); підміняється в тестах. */
export type HostLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: HostLookup = host => dnsLookup(host, { all: true });

/**
 * Куди дозволено ходити HTTP-клієнту постачальників (BR-SCON-005).
 *
 * Типово — лише публічні адреси (`validatePublicUrl`: без localhost, приватних мереж і хмарних
 * metadata). Локальні фейкові сервери (`tools/supplier-fakes`, E2E) відкриває allowlist
 * `SUPPLIER_API_DEV_ALLOWED_ORIGINS` — origin-и через кому, наприклад
 * `http://127.0.0.1:4100,http://localhost:4100`. Allowlist діє лише поза production: у production
 * сама наявність змінної — відмова старту (env.schema і конструктор нижче), щоб адміністративне
 * поле `apiUrl` не стало SSRF-дірою в локальну мережу СТО.
 *
 * Перед запитом ім'я хоста резолвиться (`checkResolved`): публічне ім'я, що веде на приватну
 * адресу, відхиляється тим самим блок-листом. Залишковий ризик — DNS rebinding між перевіркою й
 * з'єднанням (fetch резолвить ще раз); закрити його можна лише власним агентом з'єднань.
 */
export class SupplierUrlPolicy {
  private constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly lookup: HostLookup,
  ) {}

  static fromEnv(
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
    lookup: HostLookup = defaultLookup,
  ): SupplierUrlPolicy {
    return new SupplierUrlPolicy(
      parseDevAllowedOrigins(env.SUPPLIER_API_DEV_ALLOWED_ORIGINS, env.NODE_ENV),
      lookup,
    );
  }

  /** null — адресу дозволено; інакше — причина відмови (українською). */
  check(rawUrl: string): string | null {
    let origin: string;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return 'Некоректний URL';
    }
    if (this.allowedOrigins.has(origin)) return null;
    return validatePublicUrl(rawUrl);
  }

  /**
   * Адреса `apiUrl` підключення: поза allowlist фейків — лише https (секрети йдуть у заголовках
   * і тілі), плюс `check`.
   */
  checkApiUrl(rawUrl: string): string | null {
    const reason = this.check(rawUrl);
    if (reason) return reason;
    const url = new URL(rawUrl);
    if (this.allowedOrigins.has(url.origin)) return null;
    return url.protocol === 'https:' ? null : 'Дозволено лише https://';
  }

  /**
   * `check` + резолвинг імені: кожна адреса хоста — під тим самим блок-листом. Ім'я не
   * резолвиться — null: fetch сам упаде з ENOTFOUND (мережева помилка «не дійшло»).
   */
  async checkResolved(rawUrl: string): Promise<string | null> {
    const reason = this.check(rawUrl);
    if (reason) return reason;
    const url = new URL(rawUrl);
    if (this.allowedOrigins.has(url.origin)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return null; // літерал уже перевірено
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.lookup(host);
    } catch {
      return null;
    }
    for (const a of addresses) {
      const literal = a.family === 6 || a.address.includes(':') ? `[${a.address}]` : a.address;
      const blocked = validatePublicUrl(`http://${literal}/`);
      if (blocked) return `${host} → ${a.address}: ${blocked}`;
    }
    return null;
  }

  get devAllowlistActive(): boolean {
    return this.allowedOrigins.size > 0;
  }
}

/** Розбирає allowlist; у production непорожнє значення — помилка конфігурації. */
export function parseDevAllowedOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined,
): ReadonlySet<string> {
  const value = (raw ?? '').trim();
  if (!value) return new Set();
  if (nodeEnv === 'production') {
    throw new Error(
      'SUPPLIER_API_DEV_ALLOWED_ORIGINS заборонено у production — це виняток лише для локальних фейкових серверів',
    );
  }
  const out = new Set<string>();
  for (const part of value.split(',')) {
    const p = part.trim();
    if (!p) continue;
    try {
      out.add(new URL(p).origin);
    } catch {
      throw new Error(`SUPPLIER_API_DEV_ALLOWED_ORIGINS: некоректний origin «${p}»`);
    }
  }
  return out;
}
