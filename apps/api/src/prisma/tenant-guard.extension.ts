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

// Логічні комбінатори Prisma — НЕ композитні unique-ключі. Їх НЕ можна сканувати як
// composite-key об'єкти (частина (2)): `NOT:{orgId:X}` — це НЕГАЦІЯ tenant-фільтра (матчить УСІ
// ІНШІ tenant-и), а не scope; `OR/AND` мають власну (рекурсивну) обробку. Пропуск цих ключів у (2)
// закриває leak-вектор `NOT:{orgId}` (guard раніше приймав його як «composite-ключ з orgId»).
const LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT']);

/**
 * Чи є значення tenant-токена ПОЗИТИВНОЮ рівністю (прив'язує рядок до конкретного орендаря)?
 *  ✅ скаляр (`orgId: 'o1'`) — пряма рівність;
 *  ✅ `{ in: [...] }` / `{ equals: v }` — обмежена множина/рівність (легіт cross-org batch:
 *     nbu-fetch.scheduler `where:{ orgId:{ in: orgIds } }`);
 *  ❌ `{ not }`, `{ notIn }`, `{ gt/gte/lt/lte }` — НЕГАЦІЯ/діапазон: матчить ЧУЖІ tenant-и →
 *     defeat fail-closed. Такий «токен» scope НЕ дає.
 * Позиція: невідома форма фільтр-об'єкта (без in/equals) трактується як НЕ-scope (fail-closed).
 */
function isPositiveTenantBinding(val: unknown): boolean {
  if (val === undefined) return false;
  if (val === null) return false; // orgId — NOT NULL колонка: `null` матчить 0 рядків, не scope
  if (typeof val !== 'object') return true; // скаляр (string) — пряма рівність
  if (Array.isArray(val)) return false;
  const f = val as Record<string, unknown>;
  // фільтр-об'єкт: scope лише якщо це позитивна рівність/множина (in/equals) БЕЗ негації.
  if ('not' in f || 'notIn' in f) return false;
  if ('gt' in f || 'gte' in f || 'lt' in f || 'lte' in f) return false;
  if (Array.isArray(f.in) && f.in.length > 0) return true;
  if ('equals' in f && isPositiveTenantBinding(f.equals)) return true;
  return false;
}

/** Чи несе об'єкт хоч один ПОЗИТИВНО-зв'язаний tenant-токен (orgId/branchId рівність/in). */
function hasDirectTenantToken(obj: Record<string, unknown>): boolean {
  return TENANT_TOKENS.some(t => isPositiveTenantBinding(obj[t]));
}

/**
 * Чи несе `where` валідний tenant-scope. Приймає:
 *  1) top-level orgId/branchId ПОЗИТИВНОЮ рівністю (`{ orgId, deletedAt }`, `{ id, orgId }`,
 *     `{ branchId }`, `{ orgId:{ in:[...] } }`);
 *  2) composite-unique ключ-об'єкт, що містить orgId/branchId (`{ orgId_email:{...} }`,
 *     `{ branchId_channel:{...} }`) — НЕ покладаємось на назву ключа (branchId-first ключі теж є);
 *     логічні ключі (AND/OR/NOT) з (2) ВИКЛЮЧЕНО (їх обробка окрема/рекурсивна).
 *  3) `AND`: достатньо scope у будь-якій гілці (рекурсія).
 *
 * Свідома позиція щодо `OR`: top-level `OR` без sibling top-level orgId/branchId → MISS (одна OR-гілка
 * могла б матчити чужий tenant). Форсуємо підняти tenant-токен з OR назовні. `NOT:{orgId}` — теж MISS
 * (негація tenant-фільтра матчить чужі tenant-и). Негативні/діапазонні orgId-фільтри — теж MISS.
 *
 * Експортовано для прямого unit-тестування (guard-логіка не покривається мокнутими Prisma-юнітами).
 */
export function whereHasTenantScope(where: unknown): boolean {
  if (where == null || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;

  // (1) прямий top-level токен (позитивна рівність/in)
  if (hasDirectTenantToken(w)) return true;

  // (2) composite-unique ключ-об'єкт із вкладеним токеном — ЛОГІЧНІ ключі (AND/OR/NOT) пропускаємо
  //     (інакше `NOT:{orgId}` хибно рахувався б як composite-ключ з orgId → leak-вектор).
  for (const key of Object.keys(w)) {
    if (LOGICAL_KEYS.has(key)) continue;
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

  // OR/NOT свідомо НЕ дають scope самі по собі (див. docstring).
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
            // upsert.where — ЗАВЖДИ unique-ключ, тож мапить рівно на ОДИН рядок. Tenant-safe, бо:
            // (а) якщо ключ несе orgId/branchId (composite-unique orgId_email) — where вже scoped;
            // (б) якщо ключ глобально-унікальний (counterpartyId @unique) — цільовий рядок один
            //     org-wide, його orgId незмінний з create → крос-tenant запис неможливий.
            // У ОБОХ випадках create-гілку стемпимо/перевіряємо orgId (throw, якщо нема ані data, ані
            // ambient — тоді це справжній пропуск tenant-контексту).
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
