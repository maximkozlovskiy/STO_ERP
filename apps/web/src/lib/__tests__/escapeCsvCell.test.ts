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
