import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Re-throws `err` as a `BadRequestException` when Postgres SSI detects a
 * serialization conflict (P2034). Any other error is rethrown as-is.
 *
 * Use inside every `catch` block that wraps a `Serializable` `$transaction`:
 * ```ts
 * } catch (err) {
 *   throwIfSerializationConflict(err, 'Context-specific UA message.');
 * }
 * ```
 */
export function throwIfSerializationConflict(err: unknown, message: string): never {
  if (isSerializationConflict(err)) throw new BadRequestException(message);
  throw err as Error;
}

/**
 * Чи це конфлікт серіалізації `Serializable`-транзакції (Postgres 40001). Приходить у ДВОХ формах:
 *
 *   • `PrismaClientKnownRequestError` з кодом `P2034` — конфлікт помічено на запиті всередині
 *     транзакції;
 *   • `DriverAdapterError` з `cause.kind === 'TransactionWriteConflict'` — конфлікт помічено на
 *     COMMIT. Драйвер-адаптер (`@prisma/adapter-pg`) цю помилку в `P2034` не загортає.
 *
 * Перевірка лише на `P2034` пропускала другу форму: дві одночасні видачі з однієї каси давали
 * одній із них безіменну 500 замість «каса зайнята — повторіть» (review 2026-10-14, наживо:
 * 21 відповідь 500 із 32 запитів). Клас помилки адаптера не імпортуємо — звіряємо назву й `kind`.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2034';
  if (!(err instanceof Error) || err.name !== 'DriverAdapterError') return false;
  const cause: unknown = err.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { kind?: unknown }).kind === 'TransactionWriteConflict'
  );
}

/**
 * Re-throws `err` as a `ConflictException` (409) when Postgres raises an EXCLUDE-constraint
 * violation (SQLSTATE 23P01) for the named constraint. EXCLUDE-порушення не має Prisma P-коду —
 * приходить як Unknown/raw помилка з текстом що містить назву constraint. Backstop для гонок,
 * що обійшли app-level conflict-probe (напр. CAL-C1 подвійне бронювання). Інші помилки — as-is.
 */
export function throwIfExclusionConflict(
  err: unknown,
  constraintName: string,
  message: string,
): never {
  const text =
    err instanceof Error ? `${err.message}` : typeof err === 'string' ? err : String(err);
  if (text.includes('23P01') || text.includes(constraintName)) {
    throw new ConflictException(message);
  }
  throw err as Error;
}
