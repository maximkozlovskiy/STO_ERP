import type { PrismaClient } from '@prisma/client';
import { getTenantOrgId, isTenantBypassed } from '../common/tenant/tenant-context';
import { TenantIsolationError } from './tenant-isolation.error';

/**
 * Prisma `$extends` GUARD (A1 — fail-closed tenant isolation).
 *
 * Кидає {@link TenantIsolationError}, якщо запит на tenant-scoped модель іде БЕЗ orgId/branchId-фільтра
 * у `where`, або якщо `create` не має orgId (ані у data, ані в ambient ALS). Тихий крос-tenant витік →
 * гучний збій. НЕ замінює ручні `where:{orgId}` (вони коректні) — лише ловить пропуски.
 *
 * Композується OUTERMOST у [prisma.service.ts] (застосовується ОСТАННІМ у ланцюзі $extends), щоб судити
 * оригінальні args ДО того, як withSyncVersion/withFieldEncryption їх мутують.
 */

// Моделі БЕЗ orgId-колонки (junction/child/append-only-child/глобальний каталог) + Organisation
// (self-tenant: orgId===id, легітимно читається `where:{id}`). Guard пропускає їх без tenant-перевірки.
const TENANT_EXEMPT_MODELS = new Set<string>([
  // junction (composite PK, без власного orgId)
  'EmployeeZone',
  'EmployeeLift',
  'EmployeeWorkCategory',
  'ServiceWork',
  'ServiceGood',
  'WorkOrderLineEmployee',
  // child/append-only-child (tenant досягається через parent FK)
  'PricingRuleTier',
  'WebhookDelivery',
  'LoyaltyTransaction',
  // глобальний крос-tenant каталог
  'SystemTemplate',
  // self-tenant root — orgId===id, читається за `where:{id}`
  'Organisation',
]);

// Операції з `where`, які мусять нести tenant-scope (читання + оновлення + агрегати).
const GUARDED_WHERE_OPS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

// Токени, що прив'язують рядок до орендаря. branchId — теж tenant-binding (FK→GarageBranch→org):
// напр. NotificationChannelConfig/BranchProviderConfig мають composite-unique по branchId, не orgId.
const TENANT_TOKENS = ['orgId', 'branchId'] as const;

/** Чи є у переданому об'єкті хоч один прямий tenant-токен (orgId/branchId), != undefined. */
function hasDirectTenantToken(obj: Record<string, unknown>): boolean {
  return TENANT_TOKENS.some(t => obj[t] !== undefined);
}

/**
 * Чи несе `where` валідний tenant-scope. Приймає:
 *  1) top-level orgId/branchId (`{ orgId, deletedAt }`, `{ id, orgId }`, `{ branchId }`);
 *  2) composite-unique ключ-об'єкт, що містить orgId/branchId (`{ orgId_email:{...} }`,
 *     `{ branchId_channel:{...} }`) — НЕ покладаємось на назву ключа (branchId-first ключі теж є);
 *  3) `AND`: достатньо scope у будь-якій гілці (рекурсія).
 *
 * Свідома позиція щодо `OR`: top-level `OR` без sibling top-level orgId/branchId → MISS (одна OR-гілка
 * могла б матчити чужий tenant). Форсуємо підняти tenant-токен з OR назовні.
 *
 * Експортовано для прямого unit-тестування (guard-логіка не покривається мокнутими Prisma-юнітами).
 */
export function whereHasTenantScope(where: unknown): boolean {
  if (where == null || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;

  // (1) прямий top-level токен
  if (hasDirectTenantToken(w)) return true;

  // (2) composite-unique ключ-об'єкт із вкладеним токеном
  for (const key of Object.keys(w)) {
    const val = w[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (hasDirectTenantToken(val as Record<string, unknown>)) return true;
    }
  }

  // (3) AND — достатньо scope у будь-якій гілці
  const and = w.AND;
  if (and) {
    const branches = Array.isArray(and) ? and : [and];
    if (branches.some(b => whereHasTenantScope(b))) return true;
  }

  // OR свідомо НЕ дає scope сам по собі (див. docstring).
  return false;
}

/** Стемпить data.orgId з ambient ALS, якщо відсутній; кидає, якщо ambient теж немає. */
function stampOrThrowOrgId(model: string, operation: string, data: Record<string, unknown>): void {
  if (data.orgId !== undefined) return; // явний orgId — не чіпаємо
  const ambient = getTenantOrgId();
  if (ambient === undefined) throw new TenantIsolationError(model, operation);
  data.orgId = ambient;
}

export function withTenantGuard(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
          // Легітимний глобальний доступ (login/setup/share/cross-org) → пропуск.
          if (!model || isTenantBypassed() || TENANT_EXEMPT_MODELS.has(model)) {
            return query(args);
          }

          // CREATE — стемп/перевірка orgId у data (найвищий leak-ризик: рядок у чужому tenant вічний).
          if (operation === 'create') {
            const data = (args.data ?? {}) as Record<string, unknown>;
            stampOrThrowOrgId(model, operation, data);
            args = { ...args, data };
            return query(args);
          }
          if (operation === 'createMany') {
            const rows = args.data as Record<string, unknown>[] | undefined;
            if (Array.isArray(rows)) {
              rows.forEach(r => stampOrThrowOrgId(model, operation, r));
            }
            return query(args);
          }
          if (operation === 'upsert') {
            // upsert = lookup (where) + create-гілка. Обидві мусять нести tenant.
            if (!whereHasTenantScope(args.where)) throw new TenantIsolationError(model, operation);
            const create = (args.create ?? {}) as Record<string, unknown>;
            stampOrThrowOrgId(model, operation, create);
            args = { ...args, create };
            return query(args);
          }

          // READ/UPDATE/DELETE/AGGREGATE — `where` мусить нести tenant-scope.
          if (GUARDED_WHERE_OPS.has(operation)) {
            if (!whereHasTenantScope(args.where)) throw new TenantIsolationError(model, operation);
            return query(args);
          }

          // Інші операції (без where/data) — пропуск.
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
