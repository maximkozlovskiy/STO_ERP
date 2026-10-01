import { createRequire } from 'node:module';
import { loadPdfjs, pdfjsRoot, type PdfDocument, type PdfLoadingTask } from './pdf-grid.extractor';
import { RasterizeUnavailableError } from './ocr-text-layer.provider';

/**
 * Растеризація PDF-сторінок у PNG — потрібна ЛИШЕ для OCR сканів (PDF без текстового шару).
 * Окремо від pdf-grid.extractor, бо там відповідальність інша — читання готового тексту, і той
 * файл явно задокументований як такий, що працює БЕЗ рендеру.
 */

const nodeRequire = createRequire(__filename);

interface CanvasModule {
  createCanvas(
    w: number,
    h: number,
  ): {
    width: number;
    height: number;
    getContext(t: '2d'): {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
    };
    toBuffer(mime: 'image/png'): Buffer;
  };
}

let cachedCanvas: CanvasModule | null | undefined;
/** @napi-rs/canvas — нативний модуль. Прод (linux-x64-musl у Docker) його має; захист — на випадок битого образу. */
function loadCanvas(): CanvasModule | null {
  if (cachedCanvas === undefined) {
    try {
      cachedCanvas = nodeRequire('@napi-rs/canvas') as CanvasModule;
    } catch {
      cachedCanvas = null;
    }
  }
  return cachedCanvas;
}

export function isRasterizeAvailable(): boolean {
  return loadCanvas() !== null;
}

/**
 * DPI растеризації. 200 — компроміс:
 *  - нижче ~150 зривається точність (x-height друку 9pt стає <12px, LSTM починає плутати цифри);
 *  - 300 дало б 2480×3508 = 35 МБ RGBA НА СТОРІНКУ, а контейнер api має mem_limit: 1g.
 * Перевизначається OCR_DPI для діагностики скарг «не читає мою накладну» без релізу.
 */
const DEFAULT_DPI = 200;
const MIN_DPI = 100;
const MAX_DPI = 400;

function resolveDpi(explicit?: number): number {
  const fromEnv = Number(process.env.OCR_DPI);
  const raw = explicit ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_DPI);
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.trunc(raw)));
}

export interface RasterPage {
  png: Buffer;
  widthPx: number;
  heightPx: number;
}

export interface RasterizeOpts {
  maxPages?: number;
  dpi?: number;
}

/**
 * PDF → PNG посторінково, ЛІНИВО (async-генератор).
 *
 * Чому генератор, а не масив: растеризувати все наперед означало б тримати N×15 МБ RGBA одночасно
 * (5 сторінок = 78 МБ лише пікселів) при mem_limit: 1g. Із генератором пік — ОДНА сторінка:
 * споживач розпізнає її і відпускає, поки наступна ще не намальована.
 *
 * ⚠️ Викликач МУСИТЬ дочитати генератор до кінця або вийти через break/throw — інакше finally
 * не виконається і loadingTask pdfjs протече (класична пастка async-генераторів). `for await`
 * робить це автоматично.
 */
export async function* rasterizePdfPages(
  pdf: Buffer | Uint8Array,
  opts?: RasterizeOpts,
): AsyncGenerator<RasterPage> {
  const canvasMod = loadCanvas();
  if (!canvasMod) {
    throw new RasterizeUnavailableError('@napi-rs/canvas is not available');
  }

  const dpi = resolveDpi(opts?.dpi);
  const scale = dpi / 72; // pdfjs viewport — у точках (72 на дюйм)
  const pdfjs = loadPdfjs();
  const task: PdfLoadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    standardFontDataUrl: `${pdfjsRoot()}/standard_fonts/`,
    useSystemFonts: false,
    disableFontFace: true,
  });

  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => undefined);
    throw e;
  }

  try {
    const pages = Math.min(doc.numPages, Math.max(1, opts?.maxPages ?? doc.numPages));
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      // rotation ВИПРАВЛЯЄ повернуту сторінку просто в рендері — на відміну від текстової гілки,
      // де ми змушені відмовляти (там координати лишились би у нерозвернутому просторі).
      const viewport = page.getViewport({ scale, rotation: page.rotate ?? 0 });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      // Білий фон: PDF-сторінка прозора, а OCR по прозорому дає чорне полотно.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      yield { png: canvas.toBuffer('image/png'), widthPx: canvas.width, heightPx: canvas.height };
    }
  } finally {
    // doc.destroy не існує — звільняти треба loadingTask, інакше воркер pdfjs тече між запитами.
    await task.destroy().catch(() => undefined);
  }
}

/** Зручна обгортка для тестів і коротких PDF: збирає всі сторінки в масив. */
export async function rasterizePdfToPngs(
  pdf: Buffer | Uint8Array,
  opts?: RasterizeOpts,
): Promise<RasterPage[]> {
  const out: RasterPage[] = [];
  for await (const page of rasterizePdfPages(pdf, opts)) out.push(page);
  return out;
}
