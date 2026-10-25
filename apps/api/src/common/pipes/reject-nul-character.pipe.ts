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
 * Символ NUL (`\u0000`) у query-, path-параметрі АБО тілі запиту → 400 `err.query.nulCharacter`.
 *
 * Postgres не приймає NUL у текстовому параметрі («invalid byte sequence for encoding UTF8:
 * 0x00»), і будь-який пошук `?q=a%00b` у будь-якому списку системи давав 500 (TECH-DEBT §8,
 * «Списки документів», п. 3). Та сама діра у тілі: `{ name: "a\u0000b" }` долітав до Prisma й
 * давав безіменну 500 (BR-SEC-NUL). Глобальна труба (`globalPipes()`), тож покриває всі
 * маршрути — `@Query('q')`, `@Query() dto`, `@Param()` і `@Body() dto` — без правки кожного DTO.
 *
 * Тіло — вже розпарсений JSON-DTO (не сирий потік): файли йдуть через multipart (`req.parts()`
 * у контролерах завантаження), а не через цю трубу, тож великих бінарних буферів вона не чіпає.
 * `MAX_DEPTH=5` тримає обхід дешевим; імпортні тіла й так обмежені капом рядків.
 */
@Injectable()
export class RejectNulCharacterPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    // custom-метатипи (напр. `@Req()`/`@Res()`) трубу не проходять через value — skip.
    if (metadata.type === 'custom') return value;
    if (containsNul(value)) {
      throw new BadRequestException(translateError('err.query.nulCharacter', getLocale()));
    }
    return value;
  }
}
