import type { Prisma, SupplierConnection } from '@prisma/client';
import type {
  SupplierConnectionContext,
  SupplierConnectionOptions,
} from '../adapters/supplier-adapter.interface';

type Db = Pick<Prisma.TransactionClient, 'supplierConnection'>;

/** Креди — JSON-рядок «поле → значення» (шифрується розширенням Prisma, тут уже розшифрований). */
export function parseCredentials(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val !== '') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseOptions(raw: Prisma.JsonValue | null | undefined): SupplierConnectionOptions {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw)
    : {};
}

export function toConnectionContext(row: SupplierConnection): SupplierConnectionContext {
  return {
    id: row.id,
    orgId: row.orgId,
    counterpartyId: row.counterpartyId,
    provider: row.provider,
    apiUrl: row.apiUrl,
    testMode: row.testMode,
    credentials: parseCredentials(row.credentials),
    options: parseOptions(row.options),
  };
}

/** Підключення організації (не видалене) з розшифрованими кредами або null. */
export async function loadConnection(
  db: Db,
  orgId: string,
  id: string,
): Promise<SupplierConnection | null> {
  return db.supplierConnection.findFirst({ where: { id, orgId, deletedAt: null } });
}
