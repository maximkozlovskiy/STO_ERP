import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient tenant-контекст запиту/джоба (A1 — tenant-isolation guard).
 *
 * orgId у STO ERP приходить з JWT (`@OrgContext()` → `request.user.orgId`) як ЯВНИЙ аргумент методу —
 * ambient-контексту не було. Prisma `$extends` guard ([tenant-guard.extension.ts]) не має доступу до
 * аргументів контролера, тож потрібен AsyncLocalStorage-міст: interceptor кладе сюди orgId на весь
 * request, процесори — з `job.data.orgId`, а guard читає `getOrgId()` для create-стемпу і `isBypassed()`
 * для легітимних глобальних запитів (login/setup/share/cross-org).
 *
 * Плоский модуль (не Nest-provider), щоб guard-extension — теж плоска функція — імпортував напряму
 * без DI (дзеркалить `for-each-active-org.ts`).
 */
export interface TenantContext {
  /** Активний orgId для стемпу create-даних. undefined на public/unauth-роутах. */
  orgId?: string;
  /**
   * Guard пропускає запит без throw (легітимний глобальний доступ: login by email, setup-bootstrap,
   * public share-token, cross-org scheduler). Встановлюється лише через `runUnscoped`.
   */
  bypass?: boolean;
}

const tenantStore = new AsyncLocalStorage<TenantContext>();

/** Виконує `fn` у межах tenant-scope. Вкладені виклики наслідують/перекривають зовнішній контекст. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStore.run(ctx, fn);
}

/** Поточний orgId зі scope (undefined поза scope або на unauth-роуті). */
export function getTenantOrgId(): string | undefined {
  return tenantStore.getStore()?.orgId;
}

/** Чи активний bypass — guard тоді пропускає запит без tenant-перевірки. */
export function isTenantBypassed(): boolean {
  return tenantStore.getStore()?.bypass === true;
}

/**
 * Виконує `fn` з bypass=true — guard НЕ перевіряє tenant-scope для запитів усередині.
 * Обгортати ЛИШЕ явні легітимні глобальні запити (login by email, setup, public share, cross-org).
 * Зберігає наявний orgId (щоб create-стемп усередині все ще працював, якщо orgId відомий).
 */
export function runUnscoped<T>(fn: () => T): T {
  const current = tenantStore.getStore();
  return tenantStore.run({ ...current, bypass: true }, fn);
}
