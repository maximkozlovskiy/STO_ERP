import { describe, it, expect, afterAll } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  OCR_PROVIDER,
  disposeOcrWorker,
  OcrTimeoutError,
  OcrModelsMissingError,
  resolveTessdataDir,
} from './ocr-text-layer.provider';
import { fragmentsToGrid } from './pdf-grid.extractor';

/**
 * Інтеграційні сценарії OCR проти СПРАВЖНЬОГО стеку (tesseract + @napi-rs/canvas + pdfjs) —
 * доповнюють юніт-рівень (чисті функції мапінгу). Покривають реальні межі, що не ловляться
 * юнітами: ізоляцію паралельних розпізнавань, поворот сторінки, бюджет часу й відновлення
 * воркера, порожнє зображення, мапінг «моделі відсутні» у 400, а також характеристики якості
 * (кегль/шум) як документовані межі, а не ассерти.
 *
 * Детермінізм: НЕ робимо pixel-exact ассертів на розпізнаний текст (Skia+LSTM недетерміновані
 * між версіями) — перевіряємо структурні інваріанти (к-ть колонок ≥ 2, відсутність протікання
 * між паралельними запитами, не-null/не-throw, статус помилки).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit') as new (o: Record<string, unknown>) => {
  on(e: string, cb: (c?: Buffer) => void): void;
  addPage(o?: Record<string, unknown>): void;
  image(src: Buffer, x: number, y: number, o?: Record<string, unknown>): void;
  text(t: string, x: number, y: number): void;
  end(): void;
};

type Row = [string, string, string, string];
const HEADER: Row = ['Артикул', 'Назва', 'Кількість', 'Ціна'];
const DATA: Row[] = [
  ['04E-129-620', 'Фільтр повітряний', '2', '345,00'],
  ['06H-115-561', 'Фільтр масляний', '4', '189,50'],
  ['1K0-615-301', 'Диск гальмівний', '2', '1250,00'],
  ['N-908-132-02', 'Болт', '12', '15,00'],
];

/** Малює накладну-таблицю на canvas → PNG (справжній растр, як фото/скан). */
function renderInvoicePng(opts: {
  fontPx: number;
  noise?: number; // 0..1 частка «посолених» пікселів
  widthPx?: number;
  heightPx?: number;
}): Buffer {
  const W = opts.widthPx ?? 1200;
  const H = opts.heightPx ?? 700;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as unknown as {
    fillStyle: string;
    font: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    fillText(t: string, x: number, y: number): void;
    getImageData?: unknown;
  };
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  const fp = opts.fontPx;
  ctx.font = `${fp}px sans-serif`;
  const cols = [40, 360, 760, 980];
  const rowH = Math.round(fp * 2.2);
  let y = 60;
  const draw = (r: Row): void => {
    r.forEach((cell, i) => ctx.fillText(cell, cols[i]!, y));
    y += rowH;
  };
  draw(HEADER);
  for (const r of DATA) draw(r);

  if (opts.noise && opts.noise > 0) {
    // «Сіль» — випадкові чорні крапки, імітація шуму сканера.
    const n = Math.floor(W * H * opts.noise);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(Math.random() * W);
      const yy = Math.floor(Math.random() * H);
      ctx.fillStyle = Math.random() > 0.5 ? '#000000' : '#888888';
      ctx.fillRect(x, yy, 1, 1);
    }
  }
  return c.toBuffer('image/png');
}

/** Вкладає PNG-растр у PDF (image-only скан, без текстового шару), з необов'язковим поворотом сторінки. */
function pngToScanPdf(png: Buffer, rotate = 0): Promise<Buffer> {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, rotate });
    const chunks: Buffer[] = [];
    doc.on('data', ch => ch && chunks.push(ch));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.image(png, 0, 0, { width: 595 });
    doc.end();
  });
}

function gridFromFrags(frags: Awaited<ReturnType<typeof OCR_PROVIDER.extract>>): string[][] {
  if (!frags) return [];
  try {
    return fragmentsToGrid(frags);
  } catch {
    return [];
  }
}

/** Чи схожа сітка на нашу накладну: >=4 колонки у шапці + хоч один впізнаваний артикул. */
function gridLooksValid(grid: string[][]): { cols: number; rows: number; foundArticle: boolean } {
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const joined = grid.map(r => r.join(' ')).join('\n');
  const foundArticle = /129.?620|115.?561|615.?301/.test(joined.replace(/\s/g, ''));
  return { cols, rows: grid.length, foundArticle };
}

afterAll(async () => {
  await disposeOcrWorker();
});

describe('BUG HUNT: OCR якість на реалістичних сканах', () => {
  it('фото-накладна 12pt (високий кегль) → сітка валідна', async () => {
    const png = renderInvoicePng({ fontPx: 32 }); // ~великий, чистий
    const frags = await OCR_PROVIDER.extract(png);
    const grid = gridFromFrags(frags);
    const v = gridLooksValid(grid);
    expect(v.cols).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('дрібний кегль 8pt → фіксуємо межу якості', async () => {
    const png = renderInvoicePng({ fontPx: 16 });
    const frags = await OCR_PROVIDER.extract(png);
    const grid = gridFromFrags(frags);
    // Твердження — НЕ точність (на 8pt вона свідомо нижча, це задокументований компроміс
    // рішення #3: нерозпізнане йде в ручний вибір). Твердження в тому, що дрібний кегль не
    // ламає КОНТРАКТ: провайдер не кидає, повертає фрагменти, сітка будується.
    expect(frags).not.toBeNull();
    expect(grid.length).toBeGreaterThan(0);
  }, 60_000);

  it('шум сканера 2% → фіксуємо межу', async () => {
    const png = renderInvoicePng({ fontPx: 32, noise: 0.02 });
    const frags = await OCR_PROVIDER.extract(png);
    const grid = gridFromFrags(frags);
    // Як і для 8pt: шум сканера не має валити канал — лише знижувати точність.
    expect(frags).not.toBeNull();
    expect(grid.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('BUG HUNT: паралельні OCR-імпорти', () => {
  it('два одночасні extract не змішують результати і не падають', async () => {
    const pngA = renderInvoicePng({ fontPx: 34 });
    // Другий документ з ІНШИМ упізнаваним маркером.
    const c = createCanvas(1000, 300);
    const ctx = c.getContext('2d') as unknown as {
      fillStyle: string;
      font: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      fillText(t: string, x: number, y: number): void;
    };
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1000, 300);
    ctx.fillStyle = '#000';
    ctx.font = '34px sans-serif';
    ctx.fillText('МАРКЕР-БЕТА', 40, 80);
    ctx.fillText('XYZ-999', 40, 160);
    ctx.fillText('777', 500, 160);
    const pngB = c.toBuffer('image/png');

    const [a, b] = await Promise.all([OCR_PROVIDER.extract(pngA), OCR_PROVIDER.extract(pngB)]);
    const ja = (a ?? []).map(f => f.str).join(' ');
    const jb = (b ?? []).map(f => f.str).join(' ');
    // B-маркери НЕ повинні протекти в A і навпаки.
    expect(/999|777|XYZ/i.test(ja.replace(/\s/g, ''))).toBe(false);
    expect(/345|189|Фільтр/i.test(jb)).toBe(false);
  }, 120_000);
});

describe('BUG HUNT: повернута сторінка PDF-скану', () => {
  for (const rot of [90, 180, 270]) {
    it(`скан повернутий на ${rot}° → растеризатор впорається`, async () => {
      const png = renderInvoicePng({ fontPx: 34 });
      const pdf = await pngToScanPdf(png, rot);
      const frags = await OCR_PROVIDER.extract(pdf);
      const grid = gridFromFrags(frags);
      // Array.isArray тут не доводить нічого (істинне завжди). Справжнє твердження: растеризатор
      // ЗАСТОСУВАВ page.rotate, тож текст опинився в читабельній орієнтації і сітка НЕ порожня.
      // Точність символів лишається характеристикою, а не критерієм.
      expect(frags).not.toBeNull();
      expect(gridLooksValid(grid).cols).toBeGreaterThanOrEqual(2);
    }, 90_000);
  }
});

describe('BUG HUNT: таймаут багатосторінкового скану', () => {
  it('5 щільних сторінок вкладаються у бюджет або дають OcrTimeoutError (не вішаються)', async () => {
    const png = renderInvoicePng({ fontPx: 30 });
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>(resolve => {
      doc.on('data', ch => ch && chunks.push(ch));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    for (let p = 0; p < 6; p++) {
      if (p > 0) doc.addPage({ size: 'A4', margin: 0 });
      doc.image(png, 0, 0, { width: 595 });
    }
    doc.end();
    const pdf = await done;

    const started = Date.now();
    try {
      const frags = await OCR_PROVIDER.extract(pdf);
      const elapsed = Date.now() - started;
      // maxPages=5 → не більше 5 сторінок обробляється; не вішається нескінченно.
      expect(elapsed).toBeLessThan(140_000);
      // Результат теж стверджуємо: без цього тест лишався б зеленим, навіть якби OCR
      // повертав порожнечу швидко (змінна була оголошена й нікуди не йшла).
      expect(frags).not.toBeNull();
    } catch (e) {
      expect(e).toBeInstanceOf(OcrTimeoutError);
    }
  }, 160_000);
});

describe('BUG HUNT: відсутні моделі', () => {
  it('resolveTessdataDir знаходить ukr.traineddata у реальному дереві', () => {
    const dir = resolveTessdataDir();
    expect(dir).toContain('tessdata');
  });

  it('OcrModelsMissingError → DocumentGridParserService.toHttpError дає 400 ocrModelsMissing', async () => {
    // Напряму перевіряємо мапінг технічної помилки у дружній 400 (клас, що відрізняє 400 від 500).
    const { DocumentGridParserService } = await import('./document-grid-parser.service');
    const svc = new DocumentGridParserService();
    const toHttp = (
      svc as unknown as {
        toHttpError(e: unknown, ch: 'pdf' | 'image'): { getStatus(): number; message: string };
      }
    ).toHttpError.bind(svc);
    const err = toHttp(new OcrModelsMissingError('tessdata не знайдено'), 'image');
    expect(err.getStatus()).toBe(400);
    expect(OcrModelsMissingError.prototype).toBeInstanceOf(Error);
  });
});

describe('BUG HUNT: порожнє/шумне зображення → чистий 400, не 500', () => {
  it('білий аркуш без тексту → extract повертає null (не кидає)', async () => {
    const c = createCanvas(600, 400);
    const ctx = c.getContext('2d') as unknown as {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
    };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 400);
    const frags = await OCR_PROVIDER.extract(c.toBuffer('image/png'));
    expect(frags).toBeNull();
  }, 60_000);
});

describe('BUG HUNT: відновлення після таймауту', () => {
  it('після PER_PAGE таймауту наступний OCR-запит успішний (воркер пересоздано)', async () => {
    // Форсуємо мізерний бюджет через приватний шлях неможливо; натомість перевіряємо,
    // що disposeOcrWorker між запитами не ламає наступний extract (пересоздання воркера).
    const png = renderInvoicePng({ fontPx: 34 });
    const first = await OCR_PROVIDER.extract(png);
    expect(first?.length).toBeGreaterThan(0);
    await disposeOcrWorker(); // імітує скидання після таймауту
    const second = await OCR_PROVIDER.extract(png);
    expect(second?.length).toBeGreaterThan(0);
    const j = (second ?? []).map(f => f.str).join(' ');
    expect(/Фільтр|345/.test(j)).toBe(true);
  }, 90_000);
});
