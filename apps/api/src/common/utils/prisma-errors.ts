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
 * violation (SQLSTATE 23P01). EXCLUDE-порушення не має Prisma P-коду — приходить як
 * `DriverAdapterError` (повідомлення Postgres: `violates exclusion constraint "<name>"`, код у
 * `cause`) або загорнуте Unknown-помилкою з тим самим текстом. Backstop для гонок, що обійшли
 * app-level conflict-probe (подвійне бронювання підйомника чи механіка, BR-CAL-006). Інші помилки —
 * as-is.
 *
 * `messages` — повідомлення за НАЗВОЮ констрейнта: на одній таблиці їх кілька (підйомник і
 * механік), і текст 409 мусить назвати саме той ресурс, що зайнятий. Назву шукаємо в тексті
 * помилки, тож жодна назва в мапі не може бути частиною іншої. Код 23P01 без жодної відомої
 * назви → повідомлення ПЕРШОГО запису мапи.
 */
export function throwIfExclusionConflict(
  err: unknown,
  messages: Readonly<Record<string, string>>,
): never {
  const text = errorText(err);
  const hit = Object.entries(messages).find(([constraint]) => text.includes(constraint));
  if (hit) throw new ConflictException(hit[1]);
  const [fallback] = Object.values(messages);
  if (text.includes('23P01') && fallback !== undefined) throw new ConflictException(fallback);
  throw err as Error;
}

/** Текст помилки разом із полями `cause` драйвер-адаптера (повідомлення й код Postgres). */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === 'string' ? err : String(err);
  const cause: unknown = err.cause;
  if (typeof cause !== 'object' || cause === null) return err.message;
  const fields = cause as Record<string, unknown>;
  const extra = ['message', 'originalMessage', 'code', 'originalCode']
    .map(k => fields[k])
    .filter((v): v is string => typeof v === 'string');
  return [err.message, ...extra].join(' ');
}
