import { describe, it, expect } from 'vitest';
import {
  ocrWordsToFragments,
  mergeWordsIntoCells,
  type OcrPage,
  type OcrWord,
} from './ocr-text-layer.provider';
import { fragmentsToGrid, PAGE_Y_OFFSET } from './pdf-grid.extractor';
import type { TextFragment } from './text-layer.provider';

/**
 * Чисті функції OCR-мапінгу — тестуються БЕЗ tesseract і без зображень (мілісекунди).
 * Саме тут закривається найнебезпечніший клас помилок: перевернута або розірвана сітка,
 * яка виглядає структурно валідною, але дає сміття в документі.
 */

/** Слово у растрових координатах (y росте вниз). */
function word(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, bbox: { x0, y0, x1, y1 } };
}

const H = 1000; // висота растру в тестах

describe('ocrWordsToFragments — інверсія Y', () => {
  it('базова формула: y = pageHeight - bbox.y1', () => {
    const f = ocrWordsToFragments([{ height: H, words: [word('Артикул', 100, 50, 200, 70)] }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toEqual({ str: 'Артикул', x: 100, y: H - 70, w: 100, h: 20 });
  });

  it('порядок рядків: верхній рядок растру отримує БІЛЬШИЙ y', () => {
    // fragmentsToGrid сортує b.y - a.y, тож більший y має бути вище на сторінці.
    const f = ocrWordsToFragments([
      {
        height: H,
        words: [
          word('перший', 0, 50, 50, 70),
          word('другий', 0, 150, 50, 170),
          word('третій', 0, 250, 50, 270),
        ],
      },
    ]);
    expect(f[0]!.y).toBeGreaterThan(f[1]!.y);
    expect(f[1]!.y).toBeGreaterThan(f[2]!.y);
  });

  it('візуальний порядок рядків зберігається наскрізь до сітки', () => {
    const f = ocrWordsToFragments([
      {
        height: H,
        words: [
          word('Артикул', 50, 100, 150, 120),
          word('Назва', 300, 100, 400, 120),
          word('A1', 50, 160, 150, 180),
          word('Фільтр', 300, 160, 400, 180),
        ],
      },
    ]);
    const grid = fragmentsToGrid(f);
    expect(grid[0]).toEqual(['Артикул', 'Назва']); // шапка ПЕРША, не остання
    expect(grid[1]).toEqual(['A1', 'Фільтр']);
  });

  // ── Контр-тест, що доводить вибір y1 (baseline), а не y0 (верх) ──
  it('слова РІЗНОЇ висоти на спільній baseline лишаються ОДНИМ рядком', () => {
    // «Підшипник» з виносними елементами (висота 40) і «2» (висота 16) на спільній нижній межі
    // y1=200. Верхні межі різняться на 24 px при medH≈28 → yTol=14: варіант «H - y0» розніс би
    // їх у два рядки, варіант «H - y1» дає однаковий y.
    const f = ocrWordsToFragments([
      { height: H, words: [word('Підшипник', 50, 160, 250, 200), word('2', 400, 184, 420, 200)] },
    ]);
    expect(f[0]!.y).toBe(f[1]!.y); // спільна baseline → ідентичний y
    expect(fragmentsToGrid(f)).toHaveLength(1); // один рядок, не два

    // Доказ від протилежного: якби мапили за верхом (H - y0), різниця перевищила б допуск.
    const byTop = [
      { str: 'Підшипник', x: 50, y: H - 160, w: 200, h: 40 },
      { str: '2', x: 400, y: H - 184, w: 20, h: 16 },
    ];
    const medH = 28;
    expect(Math.abs(byTop[0]!.y - byTop[1]!.y)).toBeGreaterThan(medH * 0.5);
  });

  it('порожні та whitespace-слова відкидаються', () => {
    const f = ocrWordsToFragments([
      {
        height: H,
        words: [word('', 0, 0, 10, 10), word('   ', 20, 0, 30, 10), word('ok', 40, 0, 50, 10)],
      },
    ]);
    expect(f.map(x => x.str)).toEqual(['ok']);
  });

  it('вироджена висота (y0===y1) не ламає мапінг', () => {
    const f = ocrWordsToFragments([{ height: H, words: [word('A', 0, 100, 10, 100)] }]);
    expect(f[0]!.h).toBe(0);
    expect(Number.isFinite(f[0]!.y)).toBe(true);
  });

  it('сторінки розводяться на PAGE_Y_OFFSET і не змішуються', () => {
    const pages: OcrPage[] = [
      // Дві колонки на сторінку: fragmentsToGrid вимагає >=2 колонок (захист «це не таблиця»).
      { height: H, words: [word('A1', 0, 100, 50, 120), word('стор1', 200, 100, 300, 120)] },
      { height: H, words: [word('B2', 0, 100, 50, 120), word('стор2', 200, 100, 300, 120)] },
    ];
    const f = ocrWordsToFragments(pages);
    // Той самий bbox на обох сторінках → різниця рівно на зсув сторінки.
    expect(f[0]!.y - f[2]!.y).toBe(PAGE_Y_OFFSET);
    const grid = fragmentsToGrid(mergeWordsIntoCells(f));
    expect(grid).toHaveLength(2);
    expect(grid[0]).toEqual(['A1', 'стор1']); // сторінка 1 перша
  });
});

describe('mergeWordsIntoCells — злиття слів у комірки', () => {
  const frag = (str: string, x: number, y: number, w: number, h = 20): TextFragment => ({
    str,
    x,
    y,
    w,
    h,
  });

  it('сусідні слова одного рядка зливаються, колонки — ні', () => {
    // «Фільтр»+«повітряний» розділені 6 px (< 20), наступна колонка — 150 px (> 20).
    const merged = mergeWordsIntoCells([
      frag('Фільтр', 100, 500, 60),
      frag('повітряний', 166, 500, 90),
      frag('345,00', 400, 500, 55),
    ]);
    expect(merged.map(m => m.str)).toEqual(['Фільтр повітряний', '345,00']);
  });

  it('рамка злитої комірки охоплює обидва слова', () => {
    const merged = mergeWordsIntoCells([frag('AB', 100, 500, 40), frag('CD', 145, 500, 30)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.x).toBe(100);
    expect(merged[0]!.w).toBe(75); // 145 + 30 - 100
  });

  it('слова РІЗНИХ рядків не зливаються', () => {
    const merged = mergeWordsIntoCells([frag('верх', 100, 500, 40), frag('низ', 145, 400, 40)]);
    expect(merged).toHaveLength(2);
  });

  it('порожній і одноелементний вхід не падають', () => {
    expect(mergeWordsIntoCells([])).toEqual([]);
    expect(mergeWordsIntoCells([frag('A', 0, 0, 10)])).toHaveLength(1);
  });

  // ── Регресія R5: словесна грануляція ламала кількість колонок ──
  it('РЕГРЕСІЯ R5: накладна зі словесною грануляцією дає 4 колонки, а не 5', () => {
    // Відтворює реальний вихід tesseract: назва товару приходить ДВОМА словами.
    const words: OcrWord[] = [
      word('Артикул', 50, 100, 170, 122),
      word('Найменування', 300, 100, 480, 122),
      word('К-сть', 700, 100, 770, 122),
      word('Ціна', 850, 100, 910, 122),

      word('04E-129-620', 50, 160, 200, 182),
      word('Фільтр', 300, 160, 370, 182),
      word('повітряний', 378, 160, 500, 182), // зазор 8 px — одна комірка
      word('2', 740, 160, 755, 182),
      word('345,00', 850, 160, 920, 182),

      word('WL7129', 50, 220, 140, 242),
      word('Фільтр', 300, 220, 370, 242),
      word('масляний', 378, 220, 490, 242),
      word('10', 730, 220, 755, 242),
      word('85,50', 860, 220, 920, 242),
    ];
    const frags = ocrWordsToFragments([{ height: H, words }]);

    // Без злиття — зайва колонка (саме та вада, що ловиться цим тестом).
    expect(fragmentsToGrid(frags)[0]).toHaveLength(5);

    // Зі злиттям — коректна таблиця.
    const grid = fragmentsToGrid(mergeWordsIntoCells(frags));
    expect(grid).toHaveLength(3);
    expect(grid[0]).toEqual(['Артикул', 'Найменування', 'К-сть', 'Ціна']);
    expect(grid[1]).toEqual(['04E-129-620', 'Фільтр повітряний', '2', '345,00']);
    expect(grid[2]).toEqual(['WL7129', 'Фільтр масляний', '10', '85,50']);
  });

  it('результат стабільний у діапазоні gapRatio 0.6…2.0', () => {
    // Доводить, що поріг не підігнаний під одну фікстуру.
    const words: OcrWord[] = [
      word('Артикул', 50, 100, 170, 122),
      word('Найменування', 300, 100, 480, 122),
      word('Ціна', 850, 100, 910, 122),
      word('A1', 50, 160, 90, 182),
      word('Фільтр', 300, 160, 370, 182),
      word('повітряний', 378, 160, 500, 182),
      word('345,00', 850, 160, 920, 182),
    ];
    const frags = ocrWordsToFragments([{ height: H, words }]);
    for (const k of [0.6, 1.0, 1.5, 2.0]) {
      const grid = fragmentsToGrid(mergeWordsIntoCells(frags, k));
      expect(grid[1], `gapRatio=${k}`).toEqual(['A1', 'Фільтр повітряний', '345,00']);
    }
  });
});
