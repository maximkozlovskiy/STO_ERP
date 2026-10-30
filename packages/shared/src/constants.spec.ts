import { describe, it, expect } from 'vitest';
import { CALENDAR_DATE_RE, isOnlineMethodCode, kyivTodayYmd } from './constants';

// Одне визначення форми календарної дати для api, web і схем форм (TECH-DEBT §8, раніше п'ять
// різних копій: дві приймали рік 0000 — Bug #818). Мутація: прибрати `(?!0000)` → кейс року 0000.
describe('CALENDAR_DATE_RE', () => {
  it.each(['2026-10-09', '1999-01-31'])('%s — дата', v => {
    expect(CALENDAR_DATE_RE.test(v)).toBe(true);
  });

  it.each(['0000-01-01', '20261-10-09', '2026-10-09T00:00', '09.10.2026', '', '2026-1-9'])(
    '«%s» — не дата',
    v => {
      expect(CALENDAR_DATE_RE.test(v)).toBe(false);
    },
  );
});

describe('kyivTodayYmd', () => {
  it('день за Києвом, а не за UTC: 21:30 UTC влітку — уже наступна доба', () => {
    expect(kyivTodayYmd(new Date('2026-07-14T21:30:00Z'))).toBe('2026-07-15');
    expect(kyivTodayYmd(new Date('2026-07-14T20:30:00Z'))).toBe('2026-07-14');
  });

  it('узимку зсув +2: 22:30 UTC — наступна доба, 21:30 — ще та сама', () => {
    expect(kyivTodayYmd(new Date('2026-01-14T22:30:00Z'))).toBe('2026-01-15');
    expect(kyivTodayYmd(new Date('2026-01-14T21:30:00Z'))).toBe('2026-01-14');
  });
});

describe('isOnlineMethodCode — онлайн-спосіб оплати (QR, BR-PAY-031)', () => {
  // guards: BR-PAY-031
  it.each([
    ['monobank_qr', true],
    ['LIQPAY_QR', true],
    ['privat24_qr', true],
    ['cash', false],
    ['card_terminal', false],
    ['qr_card', false],
    ['', false],
    [null, false],
  ] as const)('%s → %s', (code, expected) => {
    expect(isOnlineMethodCode(code)).toBe(expected);
  });
});
