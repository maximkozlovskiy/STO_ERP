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
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
    throw new BadRequestException(message);
  throw err as Error;
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
