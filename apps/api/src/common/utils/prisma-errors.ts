import { BadRequestException } from '@nestjs/common';
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
