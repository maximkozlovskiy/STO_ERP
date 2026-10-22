/**
 * Ролі вкладки «Гарантії» нарядів (BR-WAR-005) — дзеркало `@Roles` warranties.controller:
 * перегляд — `GET /warranties`, звернення — `POST /warranties/:id/claim`. Одне місце для сторінки
 * нарядів і «Пов'язаних документів» наряду (перехід до гарантії лише тим, хто бачить вкладку).
 */
export const WARRANTY_VIEW_ROLES: readonly string[] = [
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'ACCOUNTANT',
];
export const WARRANTY_CLAIM_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'RECEPTIONIST'];

export const canViewWarranties = (role: string | null | undefined): boolean =>
  WARRANTY_VIEW_ROLES.includes(role ?? '');
export const canClaimWarranties = (role: string | null | undefined): boolean =>
  WARRANTY_CLAIM_ROLES.includes(role ?? '');
