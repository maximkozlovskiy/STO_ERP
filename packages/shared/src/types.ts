// Domain types — розширюватиметься по мірі росту schema.prisma

export type UUID = string;

export interface BaseEntity {
  id: UUID;
  orgId: UUID;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  syncVersion: bigint;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

export interface SyncRecord {
  table: string;
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  syncVersion: number;
  payload: Record<string, unknown>;
}

export function formatPersonName(
  lastName?: string | null,
  firstName?: string | null,
  companyName?: string | null,
): string {
  if (companyName) return companyName;
  return [lastName, firstName].filter(Boolean).join(' ') || '';
}
