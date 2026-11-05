/**
 * `isSerializationConflict` — жертва конфлікту серіалізації (40001) чи deadlock (40P01) у будь-якій
 * формі, в якій її віддає Prisma 7 + `@prisma/adapter-pg`. Викликачі (каса, сторно) перетворюють
 * її на 400 «спробуйте ще»; невпізнана форма — 500.
 */
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSerializationConflict, throwIfSerializationConflict } from './prisma-errors';

/** Помилка адаптера, як її будує `@prisma/adapter-pg` (клас не експортується — назва й `cause`). */
function adapterError(kind: string, originalCode: string): Error {
  const e = new Error(kind);
  e.name = 'DriverAdapterError';
  (e as Error & { cause: unknown }).cause = {
    kind,
    originalCode,
    originalMessage: 'deadlock detected',
  };
  return e;
}

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`err ${code}`, {
    code,
    clientVersion: '7.10.1',
    ...(meta ? { meta } : {}),
  });

describe('isSerializationConflict', () => {
  it('P2034 (конфлікт на запиті в транзакції) → так', () => {
    expect(isSerializationConflict(known('P2034'))).toBe(true);
  });

  it('DriverAdapterError TransactionWriteConflict (на COMMIT) → так', () => {
    expect(isSerializationConflict(adapterError('TransactionWriteConflict', '40001'))).toBe(true);
  });

  // Bug #1048: deadlock на `pg_advisory_xact_lock` / `FOR UPDATE` (сирий запит) — P2010 з помилкою
  // адаптера в meta; раніше 500 у поверненні клієнту з каси ‖ касовому сторно.
  it('P2010 «Raw query failed» з deadlock 40P01 у meta.driverAdapterError → так', () => {
    const err = known('P2010', {
      driverAdapterError: adapterError('TransactionWriteConflict', '40P01'),
    });
    expect(isSerializationConflict(err)).toBe(true);
    expect(() => throwIfSerializationConflict(err, 'повторіть')).toThrow(BadRequestException);
  });

  it('P2039 (запит ORM без P-коду) з тим самим конфліктом → так', () => {
    const err = known('P2039', {
      driverAdapterError: adapterError('TransactionWriteConflict', '40P01'),
    });
    expect(isSerializationConflict(err)).toBe(true);
  });

  it('P2010 з іншою помилкою сирого запиту (синтаксис) → ні', () => {
    const err = known('P2010', { driverAdapterError: adapterError('postgres', '42601') });
    expect(isSerializationConflict(err)).toBe(false);
    expect(() => throwIfSerializationConflict(err, 'повторіть')).toThrow(err);
  });

  it('P2010 без meta, P2002 і звичайна Error → ні', () => {
    expect(isSerializationConflict(known('P2010'))).toBe(false);
    expect(isSerializationConflict(known('P2002'))).toBe(false);
    expect(isSerializationConflict(new Error('boom'))).toBe(false);
    expect(isSerializationConflict(null)).toBe(false);
  });
});
