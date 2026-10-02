import { describe, it, expect } from 'vitest';
import {
  fragmentsToGrid,
  PdfNoTableError,
  PdfScannedError,
  PdfUnreadableError,
  PdfjsTextLayerProvider,
  pdfToGrid,
} from './pdf-grid.extractor';
import type { TextFragment } from './text-layer.provider';

/** Хелпер: фрагмент із дефолтною висотою/шириною (ширина ≈ 6px на символ, як у 9pt-шрифті). */
function f(str: string, x: number, y: number, w = str.length * 6, h = 9): TextFragment {
  return { str, x, y, w, h };
}

/** Рядок таблиці: фрагменти на одному y за заданими x. */
function row(y: number, cells: [string, number][], h = 9): TextFragment[] {
  return cells.map(([s, x]) => f(s, x, y, s.length * 6, h));
}

describe('fragmentsToGrid — чиста функція (без PDF)', () => {
  it('проста таблиця з лівим вирівнюванням', () => {
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
        ['К-сть', 380],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
        ['2', 380],
      ]),
      ...row(719, [
        ['B2', 70],
        ['Ремінь', 160],
        ['5', 380],
      ]),
    ];
    expect(fragmentsToGrid(frags)).toEqual([
      ['Артикул', 'Назва', 'К-сть'],
      ['A1', 'Фільтр', '2'],
      ['B2', 'Ремінь', '5'],
    ]);
  });

  // ── Головний регресійний тест: найчастіший вигляд реальної накладної ──
  it('ПРАВОВИРІВНЯНІ числові колонки: шапка збігається з даними', () => {
    // Геометрія виміряна на реальному PDF (pdfkit + Roboto, align:right):
    // заголовок «К-сть» x=408, його числа x=425; «Ціна» 481 vs 473; «Сума» 548 vs 543.
    // Кластеризація за лівим краєм x дала б 6 колонок замість 3 для цих полів.
    const frags = [
      ...row(755, [
        ['№', 40],
        ['Артикул', 70],
        ['Найменування', 160],
        ['К-сть', 408],
        ['Ціна', 481],
        ['Сума', 548],
      ]),
      ...row(737, [
        ['1', 40],
        ['04E-129-620', 70],
        ['Фільтр повітряний VAG', 160],
        ['2', 425],
        ['345,00', 473],
        ['690,00', 543],
      ]),
      ...row(719, [
        ['2', 40],
        ['WL7129', 70],
        ['Фільтр масляний', 160],
        ['10', 419],
        ['85,50', 479],
        ['855,00', 543],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid).toHaveLength(3);
    expect(grid[0]).toEqual(['№', 'Артикул', 'Найменування', 'К-сть', 'Ціна', 'Сума']);
    expect(grid[1]).toEqual(['1', '04E-129-620', 'Фільтр повітряний VAG', '2', '345,00', '690,00']);
    expect(grid[2]).toEqual(['2', 'WL7129', 'Фільтр масляний', '10', '85,50', '855,00']);
  });

  it('преамбула (широкий рядок над таблицею) НЕ склеює колонки таблиці', () => {
    const frags = [
      // Широкий рядок перетинає всі смуги — наївне злиття перетинів схлопнуло б колонки.
      f('Видаткова накладна № РН-00123 від 15.01.2026', 40, 800, 400, 9),
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
        ['К-сть', 380],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
        ['2', 380],
      ]),
      ...row(719, [
        ['B2', 70],
        ['Ремінь', 160],
        ['5', 380],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid[1]).toEqual(['Артикул', 'Назва', 'К-сть']); // шапка ціла
    expect(grid[2]).toEqual(['A1', 'Фільтр', '2']);
    expect(grid[0]?.filter(Boolean)).toHaveLength(1); // преамбула — в одній комірці
  });

  it('ragged-рядок (порожня комірка) лишає порожнє місце у ПРАВИЛЬНІй позиції', () => {
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
        ['К-сть', 380],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
        ['2', 380],
      ]),
      ...row(719, [
        ['B2', 70],
        ['Ремінь', 160],
        ['5', 380],
      ]),
      // без артикулу — лише назва й кількість
      ...row(701, [
        ['Прокладка', 160],
        ['3', 380],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid[3]).toEqual(['', 'Прокладка', '3']);
  });

  it('підсумковий рядок «Всього» лишається окремим рядком', () => {
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
        ['Сума', 380],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
        ['690,00', 380],
      ]),
      ...row(719, [
        ['B2', 70],
        ['Ремінь', 160],
        ['855,00', 380],
      ]),
      ...row(690, [
        ['Всього:', 160],
        ['1 545,00', 380],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid[3]).toEqual(['', 'Всього:', '1 545,00']);
  });

  it('перенос назви на другий рядок → ОКРЕМИЙ рядок (відома поведінка)', () => {
    // Усвідомлено НЕ зливаємо continuation-рядки: евристика «рядок без к-сті = продовження»
    // ризикує склеїти легітимні позиції. Користувач зніме галочку на кроці 2 майстра.
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
        ['К-сть', 380],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Підшипник ступиці', 160],
        ['1', 380],
      ]),
      ...row(725, [['передній лівий', 160]]),
      ...row(707, [
        ['B2', 70],
        ['Ремінь', 160],
        ['5', 380],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid[2]).toEqual(['', 'передній лівий', '']);
  });

  it('масштаб-незалежність: ті самі дані у 7pt і 14pt дають ту саму сітку', () => {
    const build = (h: number, step: number) => [
      ...row(
        800,
        [
          ['Артикул', 70],
          ['Назва', 160],
          ['К-сть', 380],
        ],
        h,
      ),
      ...row(
        800 - step,
        [
          ['A1', 70],
          ['Фільтр', 160],
          ['2', 380],
        ],
        h,
      ),
      ...row(
        800 - step * 2,
        [
          ['B2', 70],
          ['Ремінь', 160],
          ['5', 380],
        ],
        h,
      ),
    ];
    expect(fragmentsToGrid(build(7, 14))).toEqual(fragmentsToGrid(build(14, 28)));
  });

  it('фрагменти з h=0 (whitespace) не ламають медіану', () => {
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
      ]),
      { str: '   ', x: 300, y: 755, w: 10, h: 0 },
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
      ]),
    ];
    expect(fragmentsToGrid(frags)).toEqual([
      ['Артикул', 'Назва'],
      ['A1', 'Фільтр'],
    ]);
  });

  it('сторінки з y-зсувом не змішуються в один рядок', () => {
    const PAGE = 100_000;
    const frags = [
      ...row(755, [
        ['Артикул', 70],
        ['Назва', 160],
      ]),
      ...row(737, [
        ['A1', 70],
        ['Фільтр', 160],
      ]),
      // друга сторінка: той самий «фізичний» y, але зсунутий
      ...row(755 - PAGE, [
        ['B2', 70],
        ['Ремінь', 160],
      ]),
    ];
    const grid = fragmentsToGrid(frags);
    expect(grid).toHaveLength(3);
    expect(grid[2]).toEqual(['B2', 'Ремінь']);
  });

  it('суцільний текст без таблиці (modal < 2) → PdfNoTableError', () => {
    const frags = [f('Просто абзац тексту', 40, 800, 300), f('Ще один абзац', 40, 780, 200)];
    expect(() => fragmentsToGrid(frags)).toThrow(PdfNoTableError);
  });

  it('порожній вхід → порожня сітка (без падіння)', () => {
    expect(fragmentsToGrid([])).toEqual([]);
    expect(fragmentsToGrid([{ str: '  ', x: 0, y: 0, w: 0, h: 0 }])).toEqual([]);
  });
});

// ── Інтеграційні: справжній PDF, згенерований pdfkit (уже в deps) ──
describe('PdfjsTextLayerProvider + pdfToGrid (справжній PDF)', () => {
  type PdfTextFn = (t: string, x?: number, y?: number, o?: Record<string, unknown>) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PDFDocument = require('pdfkit') as new (o: Record<string, unknown>) => {
    on(e: string, cb: (c?: Buffer) => void): void;
    registerFont(n: string, p: string): void;
    // Конкретна сигнатура замість `Function`: той приймає будь-що функціоподібне і не
    // перевіряє ні аргументів, ні результату — сенсу в такій анотації нема.
    font(n: string): { fontSize(s: number): { text: PdfTextFn } };
    fontSize(s: number): { text: PdfTextFn };
    text(t: string, x: number, y: number, o?: Record<string, unknown>): unknown;
    rect(x: number, y: number, w: number, h: number): { fill(c: string): void };
    end(): void;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const roboto = require('pdfmake/fonts/Roboto') as { Roboto: { normal: string } };

  function build(fn: (d: InstanceType<typeof PDFDocument>) => void): Promise<Buffer> {
    return new Promise(resolve => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', c => c && chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      fn(doc);
      doc.end();
    });
  }

  it('текстовий PDF з кирилицею → сітка з колонками', async () => {
    const pdf = await build(d => {
      d.registerFont('R', roboto.Roboto.normal);
      d.font('R').fontSize(9);
      const rows: [string, string, string, string][] = [
        ['Артикул', 'Найменування', 'К-сть', 'Ціна'],
        ['04E-129-620', 'Фільтр повітряний', '2', '345,00'],
        ['WL7129', 'Фільтр масляний', '10', '85,50'],
      ];
      // pdfkit рахує y ВІД ВЕРХУ сторінки, тож рядки йдуть зі ЗРОСТАННЯМ y (а pdfjs потім
      // віддасть їх у своїх координатах від низу — екстрактор це враховує сортуванням).
      let y = 100;
      for (const r of rows) {
        d.text(r[0], 70, y);
        d.text(r[1], 160, y);
        d.text(r[2], 380, y, { width: 50, align: 'right' });
        d.text(r[3], 440, y, { width: 60, align: 'right' });
        y += 18;
      }
    });

    const { rows: grid, provider } = await pdfToGrid(pdf);
    expect(provider).toBe('pdfjs'); // текстовий шар є → OCR не запускається
    expect(grid[0]).toEqual(['Артикул', 'Найменування', 'К-сть', 'Ціна']);
    expect(grid[1]).toEqual(['04E-129-620', 'Фільтр повітряний', '2', '345,00']);
    expect(grid[2]?.[3]).toBe('85,50');
  }, 30_000);

  // УВАГА: після додавання OCR цей тест проходить з ІНШОЇ причини. Раніше — бо OCR-провайдера
  // не було взагалі; тепер — бо на сірому прямокутнику OCR теж не знаходить слів і повертає null.
  // Тому тест став повільнішим (~2 с): він реально ганяє розпізнавання.
  it('image-only PDF (скан) → PdfScannedError', async () => {
    const pdf = await build(d => {
      d.rect(50, 50, 500, 700).fill('#cccccc');
    });
    await expect(pdfToGrid(pdf)).rejects.toThrow(PdfScannedError);
  }, 30_000);

  it('не-PDF буфер → PdfUnreadableError', async () => {
    await expect(pdfToGrid(Buffer.from('this is definitely not a pdf'))).rejects.toThrow(
      PdfUnreadableError,
    );
  }, 30_000);

  it('provider.extract повертає null для скану (контракт ланцюжка провайдерів)', async () => {
    const pdf = await build(d => {
      d.rect(10, 10, 100, 100).fill('#000000');
    });
    const provider = new PdfjsTextLayerProvider();
    await expect(provider.extract(pdf)).resolves.toBeNull();
  }, 30_000);
});
