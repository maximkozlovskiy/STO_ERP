import { describe, it, expect } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { BankStatementsController } from './bank-statements.controller';

// Доступ до банківських платежів (BR-BANK-015, BR-BANK-038). RolesGuard читає metadata 'roles' з методу,
// тож перевіряємо саме її: імпорт, перегляд, рознесення, ігнорування, ручне внесення, рознесення
// вихідних і скасування рознесення — OWNER/ADMIN/ACCOUNTANT, і ніхто інший (MANAGER/MECHANIC/…
// гроші не розносять).
//
// Mutation-verify: (1) зняти `@Roles(...)` з будь-якого нового маршруту або додати туди 'MANAGER' →
// кейс цього маршруту «рівно OWNER / ADMIN / ACCOUNTANT»; (2) додати в контролер маршрут, якого
// немає в ROUTES → «жоден метод-маршрут не лишився поза переліком»; (3) зняти
// `@UseInterceptors(IdempotencyInterceptor)` з createManual → кейс про ключ ідемпотентності.
describe('BankStatementsController — доступ', () => {
  const ROUTES = [
    'rawPreview',
    'preview',
    'apply',
    'list',
    'match',
    'ignore',
    // Вихідні платежі (BR-BANK-023 / 024 / 027 / 025…034 / 039):
    'createManual',
    'removeManual',
    'supplierPaymentCandidates',
    'reconcile',
    'unreconcile',
  ] as const;

  const rolesOf = (method: (typeof ROUTES)[number]): string[] =>
    Reflect.getMetadata('roles', BankStatementsController.prototype[method]);

  // guards: BR-BANK-015, BR-BANK-038
  it.each(ROUTES)('%s — рівно OWNER / ADMIN / ACCOUNTANT', method => {
    expect(rolesOf(method)).toEqual(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  });

  // guards: BR-BANK-015
  it('контролер закритий JwtAuthGuard + RolesGuard (без них @Roles нічого не обмежує)', () => {
    const guards = Reflect.getMetadata('__guards__', BankStatementsController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  // guards: BR-BANK-015, BR-BANK-038
  it('жоден метод-маршрут контролера не лишився поза переліком цього спеку', () => {
    const proto = BankStatementsController.prototype as unknown as Record<string, object>;
    const routed = Object.getOwnPropertyNames(proto).filter(
      name => name !== 'constructor' && Reflect.getMetadata('path', proto[name]!) !== undefined,
    );
    expect(routed.sort()).toEqual([...ROUTES].sort());
  });

  // Повторний запит із тим самим Idempotency-Key не має створити другий платіж: це тримає
  // IdempotencyInterceptor на маршруті, а не сервіс.
  // guards: BR-BANK-023
  it('createManual закритий IdempotencyInterceptor — повтор із тим самим ключем не створює другий рядок', () => {
    const interceptors = Reflect.getMetadata(
      '__interceptors__',
      BankStatementsController.prototype.createManual,
    ) as unknown[] | undefined;
    expect(interceptors).toContain(IdempotencyInterceptor);
  });

  // HTTP-методи й шляхи нових маршрутів — як у таблиці «API Endpoints» дос'є.
  // guards: BR-BANK-038
  it.each([
    ['createManual', 1, 'transactions'], // POST
    ['removeManual', 3, 'transactions/:id'], // DELETE
    ['supplierPaymentCandidates', 0, 'transactions/:id/supplier-payment-candidates'], // GET
    ['reconcile', 1, 'transactions/:id/reconcile'], // POST
    ['unreconcile', 1, 'transactions/:id/unreconcile'], // POST
  ] as const)('%s — HTTP-метод і шлях із дос’є', (method, httpMethod, path) => {
    const handler = BankStatementsController.prototype[method];
    expect(Reflect.getMetadata('method', handler)).toBe(httpMethod);
    expect(Reflect.getMetadata('path', handler)).toBe(path);
  });
});
