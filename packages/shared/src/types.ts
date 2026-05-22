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
