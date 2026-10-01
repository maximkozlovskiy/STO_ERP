import { describe, it, expect } from 'vitest';
import { isRasterizeAvailable, rasterizePdfToPngs } from './pdf-rasterizer';

/**
 * Растеризатор тестується на PDF, згенерованих pdfkit (уже в deps) — жодних бінарних фікстур
 * у git, як і в сусідніх spec-ах цього модуля.
 *
 * Свідомо НЕ робимо pixel-diff проти baseline-картинки: Skia-рендер відрізняється між версіями
 * @napi-rs/canvas → тест став би перманентно червоним після апдейту. Перевіряємо інваріанти:
 * формат PNG, очікувану геометрію, обробку поворотів і лімітів.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit') as new (o: Record<string, unknown>) => {
  on(e: string, cb: (c?: Buffer) => void): void;
  addPage(o?: Record<string, unknown>): unknown;
  text(t: string, x: number, y: number): unknown;
  end(): void;
};

function buildPdf(
  fn: (d: InstanceType<typeof PDFDocument>) => void,
  opts: Record<string, unknown> = {},
): Promise<Buffer> {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, ...opts });
    const chunks: Buffer[] = [];
    doc.on('data', c => c && chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    fn(doc);
    doc.end();
  });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('pdf-rasterizer', () => {
  it('@napi-rs/canvas доступний (прод-залежність)', () => {
    expect(isRasterizeAvailable()).toBe(true);
  });

  it('A4 при 200 DPI → PNG 1654×2339', async () => {
    const pdf = await buildPdf(d => d.text('Накладна', 50, 50));
    const pages = await rasterizePdfToPngs(pdf, { dpi: 200 });

    expect(pages).toHaveLength(1);
    expect(pages[0]!.widthPx).toBe(1654); // 595pt × 200/72
    expect(pages[0]!.heightPx).toBe(2339); // 842pt × 200/72
    expect(pages[0]!.png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(pages[0]!.png.length).toBeGreaterThan(1000); // не порожній растр
  }, 30_000);

  it('DPI впливає на розмір растру пропорційно', async () => {
    const pdf = await buildPdf(d => d.text('X', 50, 50));
    const [low] = await rasterizePdfToPngs(pdf, { dpi: 100 });
    const [high] = await rasterizePdfToPngs(pdf, { dpi: 200 });
    expect(high!.widthPx).toBeCloseTo(low!.widthPx * 2, -1);
  }, 30_000);

  it('DPI клампиться у межі 100…400', async () => {
    const pdf = await buildPdf(d => d.text('X', 50, 50));
    const [tooLow] = await rasterizePdfToPngs(pdf, { dpi: 10 });
    const [min] = await rasterizePdfToPngs(pdf, { dpi: 100 });
    expect(tooLow!.widthPx).toBe(min!.widthPx);
  }, 30_000);

  it('maxPages обрізає багатосторінковий PDF', async () => {
    const pdf = await buildPdf(d => {
      d.text('с1', 50, 50);
      d.addPage();
      d.text('с2', 50, 50);
      d.addPage();
      d.text('с3', 50, 50);
    });
    const pages = await rasterizePdfToPngs(pdf, { dpi: 100, maxPages: 2 });
    expect(pages).toHaveLength(2);
  }, 60_000);

  it('повернута сторінка растеризується (а не відхиляється, як у текстовій гілці)', async () => {
    const pdf = await buildPdf(d => d.text('Накладна', 50, 50), { layout: 'landscape' });
    const pages = await rasterizePdfToPngs(pdf, { dpi: 100 });
    expect(pages).toHaveLength(1);
    // landscape → ширина більша за висоту
    expect(pages[0]!.widthPx).toBeGreaterThan(pages[0]!.heightPx);
  }, 30_000);

  it('не-PDF буфер → помилка, не тихий порожній результат', async () => {
    await expect(rasterizePdfToPngs(Buffer.from('not a pdf'))).rejects.toThrow();
  }, 30_000);
});
