import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { ExtractOpts, TextFragment, TextLayerProvider } from './text-layer.provider';

/** PDF без текстового шару (скан/фото). Викликач показує користувачу пораду, а не падає 500. */
export class PdfScannedError extends Error {}
/** PDF нечитомий: битий, запаролений або сторінка повернута. */
export class PdfUnreadableError extends Error {}
/** Текст є, але таблична структура не впізнається (суцільний текст, одна колонка). */
export class PdfNoTableError extends Error {}

/**
 * pdfjs-dist 6.x — ESM-only (`main: build/pdf.mjs`), а API компілюється у CommonJS
 * (tsconfig `module: commonjs`). ESM-граф тягнемо через `require(esm)` — unflagged у Node >=22.12
 * (у проєкті 24.14). Саме `createRequire`, а не `await import()`: tsc down-компілює `import()` у
 * `require()` і так, але createRequire — явний контракт, що не залежить від налаштувань емісії.
 * `legacy/build` — транспільований бандл без top-level await.
 *
 * Перевірено: текст (включно з кирилицею) читається БЕЗ optional `@napi-rs/canvas` — рендер нам
 * не потрібен, лише getTextContent(). Тому canvas виключений у pnpm-workspace.neverBuiltDependencies.
 */
const nodeRequire = createRequire(__filename);

interface PdfTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}
/** Viewport сторінки у піксельних координатах рендеру (scale = DPI/72). */
export interface PdfViewport {
  width: number;
  height: number;
}
export interface PdfPage {
  rotate?: number;
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  /** Потрібно растеризатору (pdf-rasterizer.ts): rotation тут ВИПРАВЛЯЄ повернуті сторінки. */
  getViewport(params: { scale: number; rotation?: number }): PdfViewport;
  render(params: { canvasContext: unknown; viewport: PdfViewport }): { promise: Promise<void> };
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
export interface PdfjsModule {
  getDocument(src: Record<string, unknown>): PdfLoadingTask;
}

let cachedPdfjs: PdfjsModule | null = null;
export function loadPdfjs(): PdfjsModule {
  if (!cachedPdfjs) cachedPdfjs = nodeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsModule;
  return cachedPdfjs;
}
export function pdfjsRoot(): string {
  return dirname(nodeRequire.resolve('pdfjs-dist/package.json'));
}

/**
 * Зсув y на сторінку: координати різних сторінок перетинаються (кожна починає відлік від свого
 * низу), тож без зсуву рядки різних сторінок злились би в один при Y-групуванні.
 */
export const PAGE_Y_OFFSET = 100_000;
const DEFAULT_MAX_PAGES = 20;

/** Медіана (для непарного — середній, для парного — нижній середній; точність тут не критична). */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

interface GridLine {
  y: number;
  items: TextFragment[];
}

/**
 * Фрагменти → сітка `string[][]`. ЧИСТА функція: не знає ні про pdfjs, ні про OCR, тестується
 * без жодного PDF (див. pdf-grid.extractor.spec.ts).
 *
 * Алгоритм (кожен крок — відповідь на реальну ваду, перевірену на фікстурах):
 *  1) фільтр порожніх фрагментів (pdfjs видає whitespace-елементи з h=0);
 *  2) медіанна висота → усі допуски похідні від неї (працює і для 7pt, і для 14pt);
 *  3) групування в рядки за y (допуск medH*0.5), сортування: y спадає (PDF-координати зростають
 *     вгору, а рядки документа йдуть зверху вниз), всередині рядка — x зростає;
 *  4) МОДАЛЬНА кількість фрагментів у рядку = справжня кількість колонок; рядки саме з такою
 *     кількістю — «тіло таблиці»;
 *  5) смуги колонок будуються за ОРДИНАЛЬНОЮ позицією у body-рядках: k-й фрагмент body-рядка за
 *     визначенням належить k-й колонці. Це ключ до правильності — кластеризація за лівим краєм x
 *     ламається на правовирівняних числах (виміряно на реальному PDF: заголовок «К-сть» x=408,
 *     його числа x=425; «Ціна» 481 vs 473) і дала б 9 колонок замість 6;
 *  6) усі рядки (включно з шапкою й преамбулою) розкладаються по смугах за максимальним перетином.
 *     Наївне злиття перетинів по ВСІХ фрагментах натомість ламається на преамбулі: широкий рядок
 *     «Видаткова накладна № …» перетинає всі колонки й склеїв би їх в одну.
 */
export function fragmentsToGrid(frags: readonly TextFragment[]): string[][] {
  const items = frags.filter(f => f.str && f.str.trim());
  if (!items.length) return [];

  const medH = median(items.map(f => f.h).filter(h => h > 0)) || 10;
  const yTol = medH * 0.5;

  // ── Крок 3: групування в рядки ──
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: GridLine[] = [];
  for (const f of sorted) {
    const line = lines.find(l => Math.abs(l.y - f.y) <= yTol);
    if (line) line.items.push(f);
    else lines.push({ y: f.y, items: [f] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);

  // ── Крок 4: модальна кількість колонок ──
  const freq = new Map<number, number>();
  for (const l of lines) freq.set(l.items.length, (freq.get(l.items.length) ?? 0) + 1);
  let modal = 0;
  let modalFreq = 0;
  for (const [count, n] of freq) {
    // При рівності частот виграє БІЛЬША кількість: таблиця з 6 колонок і 6 рядків преамбули по
    // 1 фрагменту не має схлопнутись в одну колонку.
    if (n > modalFreq || (n === modalFreq && count > modal)) {
      modal = count;
      modalFreq = n;
    }
  }
  if (modal < 2) throw new PdfNoTableError('no table structure');

  // ── Крок 5: смуги колонок за ординальною позицією ──
  const body = lines.filter(l => l.items.length === modal);
  const bands: { a: number; b: number }[] = [];
  for (let k = 0; k < modal; k++) {
    let a = Number.POSITIVE_INFINITY;
    let b = Number.NEGATIVE_INFINITY;
    for (const l of body) {
      const it = l.items[k];
      if (!it) continue;
      if (it.x < a) a = it.x;
      if (it.x + it.w > b) b = it.x + it.w;
    }
    bands.push({ a, b });
  }

  // ── Крок 6: розкладання всіх рядків ──
  const grid: string[][] = [];
  for (const l of lines) {
    const cells: string[] = new Array<string>(modal).fill('');
    for (const f of l.items) {
      const fa = f.x;
      const fb = f.x + f.w;
      let bestK = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < modal; k++) {
        const band = bands[k];
        if (!band) continue;
        const overlap = Math.min(fb, band.b) - Math.max(fa, band.a);
        // Є перетин → виграє найбільший; немає в жодній → найближча смуга (score = -відстань).
        const score =
          overlap > 0 ? overlap : -Math.min(Math.abs(fa - band.b), Math.abs(band.a - fb));
        if (score > bestScore) {
          bestScore = score;
          bestK = k;
        }
      }
      cells[bestK] = cells[bestK] ? `${cells[bestK]} ${f.str.trim()}` : f.str.trim();
    }
    grid.push(cells);
  }
  return grid;
}

/** Витяг текстового шару PDF через pdfjs. `null` → текстового шару немає (скан). */
export class PdfjsTextLayerProvider implements TextLayerProvider {
  readonly name = 'pdfjs' as const;

  async extract(buffer: Buffer | Uint8Array, opts?: ExtractOpts): Promise<TextFragment[] | null> {
    const pdfjs = loadPdfjs();
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false, // security: без eval
      standardFontDataUrl: `${pdfjsRoot()}/standard_fonts/`,
      useSystemFonts: false, // детермінізм, без сканування шрифтів ФС
      disableFontFace: true,
    });

    let doc: PdfDocument;
    try {
      doc = await task.promise;
    } catch (e) {
      await task.destroy().catch(() => undefined);
      throw new PdfUnreadableError(e instanceof Error ? e.message : 'unreadable pdf');
    }

    const out: TextFragment[] = [];
    try {
      const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_PAGES);
      const pages = Math.min(doc.numPages, maxPages);
      for (let p = 1; p <= pages; p++) {
        const page = await doc.getPage(p);
        // Повернуту сторінку не намагаємось виправляти — координати в нерозвернутому просторі
        // дали б переплутані колонки. Чесна помилка краща за тихо зіпсовану сітку.
        if (page.rotate) throw new PdfUnreadableError('rotated page');
        const content = await page.getTextContent();
        const yShift = (p - 1) * PAGE_Y_OFFSET;
        for (const it of content.items) {
          const str = it.str ?? '';
          if (!str.trim()) continue;
          const tr = it.transform ?? [];
          out.push({
            str,
            x: tr[4] ?? 0,
            y: (tr[5] ?? 0) - yShift,
            w: it.width ?? 0,
            h: it.height ?? 0,
          });
        }
      }
    } finally {
      // doc.destroy не існує — звільняти треба loadingTask, інакше воркер pdfjs тече між запитами.
      await task.destroy().catch(() => undefined);
    }

    return out.length ? out : null; // null → скан, викликач спробує наступного провайдера
  }
}

/** Ланцюжок провайдерів тексту. OCR додасться сюди другим елементом, без інших змін. */
export const TEXT_LAYER_PROVIDERS: readonly TextLayerProvider[] = [new PdfjsTextLayerProvider()];

/**
 * PDF → сітка. Перебирає провайдерів; перший, що дав текст, виграє. Якщо жоден не дав —
 * PdfScannedError (коли з'явиться OCR-провайдер, цей самий код піде в нього замість помилки).
 */
export async function pdfToGrid(
  buffer: Buffer | Uint8Array,
  opts?: ExtractOpts,
): Promise<string[][]> {
  for (const provider of TEXT_LAYER_PROVIDERS) {
    const frags = await provider.extract(buffer, opts);
    if (frags?.length) return fragmentsToGrid(frags);
  }
  throw new PdfScannedError('no text layer');
}
