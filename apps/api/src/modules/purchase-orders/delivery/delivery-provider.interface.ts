import type { DeliveryStatus } from '@prisma/client';

/** Креди + база API служби доставки (per-branch, write-only, шифруються at-rest). */
export interface DeliveryConfig {
  apiUrl?: string | null;
  /** Секрети (розпарсений JSON з BranchProviderConfig.credentials): novaposhta → { apiKey }. */
  credentials: Record<string, string>;
}

export interface DeliveryStatusResult {
  /** Нормалізований статус доставки. */
  status: DeliveryStatus;
  /** Сирий текст статусу служби доставки (для тултипа UI). */
  raw: string;
}

export interface DeliveryVerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Абстракція служби доставки (трекінг за накладною). Дозволяє додавати служби (Нова Пошта,
 * Укрпошта, Meest) без зміни polling-процесора — той лише робить `registry.get(code)`.
 * Модель — polling статусу за номером накладної (без webhook/публічного endpoint, offline-first).
 */
export interface DeliveryProvider {
  /** Унікальний код (зберігається у BranchProviderConfig.provider). */
  readonly code: string;
  /** Людська назва для UI. */
  readonly name: string;

  /** Опитати статус за номером накладної → нормалізований статус. */
  getStatus(cfg: DeliveryConfig, trackingNumber: string): Promise<DeliveryStatusResult>;

  /** Перевірити креди (валідність API-ключа) — БЕЗ побічних ефектів. */
  verifyCredentials(cfg: DeliveryConfig): Promise<DeliveryVerifyResult>;
}
