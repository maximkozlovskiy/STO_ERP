import { BadRequestException, Injectable } from '@nestjs/common';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/** Глибина обходу вкладених query-параметрів (`?a[b][c]=…`); глибше — не дивимось. */
const MAX_DEPTH = 5;

function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some(v => containsNul(v, depth + 1));
}

/**
 * Символ NUL (`\u0000`) у query- чи path-параметрі → 400 `err.query.nulCharacter`.
 *
 * Postgres не приймає NUL у текстовому параметрі («invalid byte sequence for encoding UTF8:
 * 0x00»), і будь-який пошук `?q=a%00b` у будь-якому списку системи давав 500 (TECH-DEBT §8,
 * «Списки документів», п. 3). Глобальна труба (`globalPipes()`), тож покриває всі маршрути —
 * і `@Query('q')`, і `@Query() dto` — без правки кожного DTO. Тіло запиту не чіпає.
 */
@Injectable()
export class RejectNulCharacterPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'query' && metadata.type !== 'param') return value;
    if (containsNul(value)) {
      throw new BadRequestException(translateError('err.query.nulCharacter', getLocale()));
    }
    return value;
  }
}
