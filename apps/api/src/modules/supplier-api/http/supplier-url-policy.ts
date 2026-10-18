import { validatePublicUrl } from '../../../common/utils/url-guard';

/**
 * Куди дозволено ходити HTTP-клієнту постачальників (BR-SCON-005).
 *
 * Типово — лише публічні адреси (`validatePublicUrl`: без localhost, приватних мереж і хмарних
 * metadata). Локальні фейкові сервери (`tools/supplier-fakes`, E2E) відкриває allowlist
 * `SUPPLIER_API_DEV_ALLOWED_ORIGINS` — origin-и через кому, наприклад
 * `http://127.0.0.1:4100,http://localhost:4100`. Allowlist діє лише поза production: у production
 * сама наявність змінної — відмова старту (env.schema і конструктор нижче), щоб адміністративне
 * поле `apiUrl` не стало SSRF-дірою в локальну мережу СТО.
 */
export class SupplierUrlPolicy {
  private constructor(private readonly allowedOrigins: ReadonlySet<string>) {}

  static fromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): SupplierUrlPolicy {
    return new SupplierUrlPolicy(
      parseDevAllowedOrigins(env.SUPPLIER_API_DEV_ALLOWED_ORIGINS, env.NODE_ENV),
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
