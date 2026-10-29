/**
 * Тихі години (BR-AUT-013): вікно [початок, кінець) за Києвом, з переходом через північ; DST —
 * через `kyivOffsetMs`, ніколи `+03:00`. Пауза — до кінця вікна.
 */
import { describe, it, expect } from 'vitest';
import {
  formatKyivDate,
  formatKyivTime,
  formatMoneyUah,
  parseHhMm,
  quietHoursDelayMs,
} from './automation-text';

const H = 3_600_000;
const M = 60_000;

describe('quietHoursDelayMs', () => {
  // guards: BR-AUT-013
  it('вікно через північ 21:00–09:00, літній час (+03:00): 22:00 Києва → пауза до 09:00 завтра', () => {
    // 15.07.2026 22:00 Києва = 19:00Z; 16.07 09:00 Києва = 06:00Z.
    expect(quietHoursDelayMs(new Date('2026-07-15T19:00:00.000Z'), '21:00', '09:00')).toBe(11 * H);
  });

  // guards: BR-AUT-013
  it('зимовий час (+02:00): 03:15 Києва → пауза до 09:00 того самого дня', () => {
    // 10.01.2026 03:15 Києва = 01:15Z; 09:00 Києва = 07:00Z.
    expect(quietHoursDelayMs(new Date('2026-01-10T01:15:00.000Z'), '21:00', '09:00')).toBe(
      5 * H + 45 * M,
    );
  });

  // guards: BR-AUT-013
  it('ніч переходу на зимовий час (25.10.2026): кінець вікна — 09:00 уже за +02:00', () => {
    // 24.10 23:00 Києва (+03:00) = 20:00Z; 25.10 09:00 Києва (+02:00) = 07:00Z → 11 год.
    expect(quietHoursDelayMs(new Date('2026-10-24T20:00:00.000Z'), '21:00', '09:00')).toBe(11 * H);
  });

  // guards: BR-AUT-013
  it('межі: початок — уже тихо, кінець — уже можна; поза вікном — 0', () => {
    // 15.07 21:00 Києва = 18:00Z — тихо; 09:00 = 06:00Z — можна; 12:00 = 09:00Z — можна.
    expect(quietHoursDelayMs(new Date('2026-07-15T18:00:00.000Z'), '21:00', '09:00')).toBe(12 * H);
    expect(quietHoursDelayMs(new Date('2026-07-15T06:00:00.000Z'), '21:00', '09:00')).toBe(0);
    expect(quietHoursDelayMs(new Date('2026-07-15T09:00:00.000Z'), '21:00', '09:00')).toBe(0);
  });

  // guards: BR-AUT-013
  it('вікно в межах доби (13:00–14:00), однакові межі й некоректний формат — без паузи поза вікном', () => {
    expect(quietHoursDelayMs(new Date('2026-07-15T10:30:00.000Z'), '13:00', '14:00')).toBe(30 * M);
    expect(quietHoursDelayMs(new Date('2026-07-15T10:30:00.000Z'), '13:00', '13:00')).toBe(0);
    expect(quietHoursDelayMs(new Date('2026-07-15T19:00:00.000Z'), '9pm', '09:00')).toBe(0);
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('07:05')).toBe(425);
  });
});

describe('Форматування змінних шаблону', () => {
  // guards: BR-AUT-014
  it('сума — «1 250,00 грн», дата й час — за Києвом', () => {
    expect(formatMoneyUah(1250).replace(/\s/g, ' ')).toBe('1 250,00 грн');
    // 31.10.2026 22:30Z = 01.11.2026 00:30 Києва (+02:00).
    const d = new Date('2026-10-31T22:30:00.000Z');
    expect(formatKyivDate(d)).toBe('01.11.2026');
    expect(formatKyivTime(d)).toBe('00:30');
  });
});
