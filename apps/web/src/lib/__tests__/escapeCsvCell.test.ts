import { describe, it, expect } from 'vitest';
import { escapeCsvCell } from '@/lib/utils';

describe('escapeCsvCell — formula-injection guard (CWE-1236)', () => {
  it('префіксує апострофом небезпечні лідери формул', () => {
    // Містить лапки → після префіксу ще й CSV-квотується (лапки подвоюються) — це коректно.
    expect(escapeCsvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(escapeCsvCell('+1+2')).toBe("'+1+2");
    expect(escapeCsvCell('-cmd')).toBe("'-cmd");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // \t лідер → префікс; сам \t не є ; " \n → без квотування.
    expect(escapeCsvCell('\t=1')).toBe("'\t=1");
    // Проста формула без спецсимволів → лише префікс, без квотування.
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
  });

  // Апостроф перед «-500» робив від'ємне сальдо текстом у Excel (у dev-базі 2026-10-25 таких
  // рахунків 156); чисте число формулою бути не може.
  it("від'ємне число лишається числом; «-» з чимось ще — як і раніше, з апострофом", () => {
    expect(escapeCsvCell(-500)).toBe('-500');
    expect(escapeCsvCell('-4865.968')).toBe('-4865.968');
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
    expect(escapeCsvCell('-1e3')).toBe("'-1e3");
    expect(escapeCsvCell('-')).toBe("'-");
  });

  // Excel з українськими налаштуваннями читає дріб із комою; «1250.5» лишався текстом, «1.05» —
  // ставав датою. Рядок не чіпається: «1.05» у тексті може бути артикулом.
  it('число (number) — з десятковою комою; рядок із крапкою — як є', () => {
    expect(escapeCsvCell(1250.5)).toBe('1250,5');
    expect(escapeCsvCell(-1250.5)).toBe('-1250,5');
    expect(escapeCsvCell(0.3)).toBe('0,3');
    expect(escapeCsvCell('1.05')).toBe('1.05');
    // кома-роздільник (виклик із ',') — дріб із комою береться в лапки
    expect(escapeCsvCell(1.5, ',')).toBe('"1,5"');
  });

  it('звичайний текст не чіпає', () => {
    expect(escapeCsvCell('Іван Петренко')).toBe('Іван Петренко');
    expect(escapeCsvCell('ТОВ Альфа')).toBe('ТОВ Альфа');
    expect(escapeCsvCell(1250)).toBe('1250');
  });

  it('квотує клітинку з роздільником/лапками/переносом', () => {
    expect(escapeCsvCell('a;b')).toBe('"a;b"');
    expect(escapeCsvCell('has "quote"')).toBe('"has ""quote"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    // кома як роздільник (ReportBuilder)
    expect(escapeCsvCell('a,b', ',')).toBe('"a,b"');
    // за замовч. ';' — кома НЕ квотується
    expect(escapeCsvCell('a,b')).toBe('a,b');
  });

  it('formula-лідер + роздільник → і префікс, і квотування', () => {
    // =A1;B1 → префікс апострофа, потім квотування бо містить ';'
    expect(escapeCsvCell('=A1;B1')).toBe('"\'=A1;B1"');
  });

  it('null/undefined → порожній рядок', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});
