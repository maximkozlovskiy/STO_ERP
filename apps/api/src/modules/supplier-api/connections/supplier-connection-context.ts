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
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/**
 * Підключення без кешу токена: `authState` шифрований і потрібен лише адаптерам із JWT (UTR, AD),
 * які читають його самі через `SupplierAuthSession` — інакше він розшифровувався б двічі, а для
 * решти адаптерів — даремно.
 */
export type ConnectionRow = Omit<SupplierConnection, 'authState'>;

export function toConnectionContext(row: ConnectionRow): SupplierConnectionContext {
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
): Promise<ConnectionRow | null> {
  return db.supplierConnection.findFirst({
    where: { id, orgId, deletedAt: null },
    omit: { authState: true },
  });
}

/** Кілька підключень організації (не видалених) одним запитом — мапа за id. */
export async function loadConnections(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<Map<string, ConnectionRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.supplierConnection.findMany({
    where: { id: { in: unique }, orgId, deletedAt: null },
    omit: { authState: true },
    take: unique.length,
  });
  return new Map(rows.map(r => [r.id, r]));
}
