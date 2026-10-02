import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
// Прямо з grid-geometry, а НЕ через pdf-grid.extractor: той тримає реєстр провайдерів
// (і знає про цей файл), тож імпорт звідти створював би цикл.
import { PAGE_Y_OFFSET, groupFragmentsIntoLines, medianFragmentHeight } from './grid-geometry';
import { rasterizePdfPages } from './pdf-rasterizer';
import type { ExtractOpts, TextFragment, TextLayerProvider } from './text-layer.provider';

/** OCR не вклався у бюджет часу. */
export class OcrTimeoutError extends Error {}
/** Моделі розпізнавання не знайдені на диску (битий образ / забутий COPY у Dockerfile). */
export class OcrModelsMissingError extends Error {}

/** Слово від tesseract: текст + рамка у РАСТРОВИХ координатах (y росте ВНИЗ). */
export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Сторінка результату OCR. height — висота растру в пікселях (потрібна для інверсії Y). */
export interface OcrPage {
  words: OcrWord[];
  height: number;
}

/**
 * Слова OCR → фрагменти у системі координат `fragmentsToGrid`.
 *
 * ІНВЕРСІЯ Y: `fragmentsToGrid` сортує `b.y - a.y`, тобто очікує PDF-конвенцію — більший y вище
 * на сторінці. Растрові bbox навпаки: y росте вниз. Тому `y = pageHeight - bbox.y1`.
 *
 * Чому саме `y1`, а не `y0`: `y1` — НИЖНЯ межа слова, тож після інверсії отримуємо відстань від
 * низу сторінки до низу слова — аналог baseline, який у pdfjs-провайдері приходить з
 * `transform[5]`. Baseline — єдина Y-ознака, стабільна між словами РІЗНОЇ висоти в одному рядку
 * («2» проти «Підшипник»). Якби брали `y0` (верх), слова різної висоти розійшлися б по Y на
 * різницю висот, а допуск групування в рядки — лише `medH * 0.5`, тож один рядок накладної
 * розпався б на два.
 *
 * Багатосторінковість: той самий зсув `- pageIndex * PAGE_Y_OFFSET`, що й у pdfjs-провайдері
 * (мінус, бо наступні сторінки мають бути НИЖЧЕ при сортуванні за спаданням y).
 */
export function ocrWordsToFragments(pages: readonly OcrPage[]): TextFragment[] {
  const out: TextFragment[] = [];
  pages.forEach((page, pageIndex) => {
    const yShift = pageIndex * PAGE_Y_OFFSET;
    for (const w of page.words) {
      const str = (w.text ?? '').trim();
      if (!str) continue;
      const { x0, y0, x1, y1 } = w.bbox;
      out.push({
        str,
        x: x0,
        y: page.height - y1 - yShift,
        w: x1 - x0,
        h: y1 - y0,
      });
    }
  });
  return out;
}

/**
 * Зливає сусідні слова одного рядка в «комірки» таблиці.
 *
 * НАВІЩО: `fragmentsToGrid` визначає кількість колонок за МОДАЛЬНОЮ кількістю фрагментів у рядку.
 * pdfjs віддає фрагмент ≈ цілу комірку («Фільтр повітряний» одним шматком), а tesseract — ОКРЕМІ
 * СЛОВА. Без злиття рядок «04E-129-620 | Фільтр повітряний | 2 | 345,00» дає 5 фрагментів замість
 * 4 → сітка отримує зайву колонку, а шапка перестає збігатися з даними (перевірено на реальному
 * растрі: 4×5 замість 4×4).
 *
 * ЯК: у межах рядка (той самий допуск за Y, що й у fragmentsToGrid) зливаємо сусідів, якщо
 * горизонтальний зазор `<= medH * gapRatio`. Міжслівний пробіл ≈ 0.3×висоти, міжколонковий —
 * кілька висот, тож поріг 1.0 впевнено розділяє ці випадки. Емпірично результат стабільний
 * у діапазоні gapRatio 0.6…2.0 — рішення не крихке.
 *
 * `fragmentsToGrid` НЕ чіпаємо: вона лишається джерело-агностичною, а нормалізація грануляції —
 * відповідальність постачальника тексту.
 */
export function mergeWordsIntoCells(
  frags: readonly TextFragment[],
  gapRatio = 1.0,
): TextFragment[] {
  if (frags.length <= 1) return [...frags];

  const medH = medianFragmentHeight(frags);
  const maxGap = medH * gapRatio;

  // Рядки групуємо ТІЄЮ САМОЮ функцією, що й fragmentsToGrid — спільний допуск за побудовою,
  // а не за домовленістю (розсинхрон давав би тихо зсунуту сітку). Вона ж сортує items за x.
  const lines = groupFragmentsIntoLines(frags, medH);

  const out: TextFragment[] = [];
  for (const line of lines) {
    let cur: TextFragment | null = null;
    for (const f of line.items) {
      if (cur && f.x - (cur.x + cur.w) <= maxGap) {
        // Злиття: текст через пробіл, рамка розтягується до правого краю нового слова.
        // h беремо максимальну — рядок із великою цифрою і малим текстом має висоту більшого.
        cur = {
          str: `${cur.str} ${f.str}`,
          x: cur.x,
          y: Math.min(cur.y, f.y),
          w: f.x + f.w - cur.x,
          h: Math.max(cur.h, f.h),
        };
      } else {
        if (cur) out.push(cur);
        cur = { ...f };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ─── Рушій ──────────────────────────────────────────────────────────────────

const nodeRequire = createRequire(__filename);

/** Мови разом: накладні українські, але АРТИКУЛИ латиницею — на самій `ukr` вони плутаються. */
const OCR_LANGS = 'ukr+eng';
/** LSTM-only (OEM=1): tessdata_fast містить лише LSTM-моделі, legacy-рушій там відсутній. */
const OCR_ENGINE_MODE = 1;
/** 0.6–1.2 с типово → 30 с це 25–50× запас на слабке залізо чи шумне фото. */
const PER_PAGE_TIMEOUT_MS = 30_000;
/** Нижче Node requestTimeout (300 с), щоб спрацював НАШ таймаут із зрозумілою помилкою. */
const TOTAL_TIMEOUT_MS = 120_000;
/** OCR-сторінка коштує ~1 с і ~15 МБ RGBA — жорсткіше за ліміт текстової гілки (20). */
const OCR_MAX_PAGES = 5;

interface TesseractWorker {
  recognize(
    image: Buffer | Uint8Array,
    opts?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: { blocks?: unknown[] } }>;
  terminate(): Promise<void>;
}

let cachedTessdataDir: string | null = null;

/**
 * Каталог із `.traineddata`. dist і src мають однакову глибину (rootDir:src → outDir:dist),
 * тож той самий відносний шлях працює і в dev, і в прод-образі.
 */
export function resolveTessdataDir(): string {
  if (cachedTessdataDir) return cachedTessdataDir;
  const candidates = [
    ...(process.env.OCR_TESSDATA_PATH ? [process.env.OCR_TESSDATA_PATH] : []),
    resolve(__dirname, '..', '..', '..', 'assets', 'tessdata'),
    resolve(process.cwd(), 'apps', 'api', 'assets', 'tessdata'),
    resolve(process.cwd(), 'assets', 'tessdata'),
  ];
  const dir = candidates.find(d => existsSync(join(d, 'ukr.traineddata')));
  if (!dir) {
    // Найімовірніша регресія: зібрали образ, забули COPY assets у Dockerfile.
    throw new OcrModelsMissingError(`tessdata не знайдено; шукали: ${candidates.join(', ')}`);
  }
  cachedTessdataDir = dir;
  return dir;
}

let workerPromise: Promise<TesseractWorker> | null = null;
/** Серіалізація: recognize НЕ reentrant — два паралельні виклики на одному воркері дають race. */
let busyChain: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    const { createWorker } = nodeRequire('tesseract.js') as {
      createWorker: (
        langs: string,
        oem: number,
        opts: Record<string, unknown>,
      ) => Promise<TesseractWorker>;
    };
    workerPromise = createWorker(OCR_LANGS, OCR_ENGINE_MODE, {
      langPath: resolveTessdataDir(),
      gzip: false, // моделі лежать розпакованими у assets
      cacheMethod: 'none', // ЖОДНОГО кешу/CDN — офлайн-вимога (ADR-001)
      logger: () => undefined,
      errorHandler: () => undefined,
    }).catch((e: unknown) => {
      workerPromise = null; // не кешуємо провальну ініціалізацію
      throw e;
    });
  }
  return workerPromise;
}

/** Знищує воркер і скидає кеш — після таймауту (воркер у невідомому стані) і на shutdown. */
export async function disposeOcrWorker(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  if (!current) return;
  await current.then(w => w.terminate()).catch(() => undefined);
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = busyChain.then(fn, fn); // помилка попереднього НЕ ламає черги
  busyChain = run.catch(() => undefined); // хвіст не тримає rejected promise
  return run;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OcrTimeoutError(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** PDF за magic bytes, не за розширенням — провайдер не бачить імені файлу (і не повинен). */
function isPdfBuffer(b: Buffer): boolean {
  return b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-';
}

interface TesseractBlock {
  paragraphs?: { lines?: { words?: OcrWord[] }[] }[];
}

function collectWords(blocks: unknown[]): OcrWord[] {
  return (blocks as TesseractBlock[])
    .flatMap(b => b.paragraphs ?? [])
    .flatMap(p => p.lines ?? [])
    .flatMap(l => l.words ?? [])
    .filter(w => w?.text && w.text.trim() && w.bbox);
}

/**
 * Розпізнавання тексту на зображенні або PDF-скані.
 *
 * Tesseract у Node працює через worker_threads, тож розпізнавання НЕ блокує event loop API —
 * синхронний режим імпорту (рішення користувача) архітектурно коректний.
 */
@Injectable()
export class OcrTextLayerProvider implements TextLayerProvider {
  readonly name = 'ocr' as const;
  private readonly logger = new Logger(OcrTextLayerProvider.name);

  async extract(buffer: Buffer | Uint8Array, opts?: ExtractOpts): Promise<TextFragment[] | null> {
    const buf = Buffer.from(buffer);
    const started = Date.now();
    const maxPages = Math.min(opts?.maxPages ?? OCR_MAX_PAGES, OCR_MAX_PAGES);
    const pages: OcrPage[] = [];

    const budgetLeft = (): number => TOTAL_TIMEOUT_MS - (Date.now() - started);

    if (isPdfBuffer(buf)) {
      // Стрімінг: растеризуємо й одразу розпізнаємо — пік пам'яті = одна сторінка.
      for await (const page of rasterizePdfPages(buf, { maxPages })) {
        if (budgetLeft() <= 0) throw new OcrTimeoutError('ocr total budget exceeded');
        pages.push(await this.recognizePage(page.png, page.heightPx, budgetLeft()));
      }
    } else {
      pages.push(await this.recognizePage(buf, undefined, budgetLeft()));
    }

    const frags = mergeWordsIntoCells(ocrWordsToFragments(pages));
    this.logger.debug(
      `OCR: ${pages.length} стор., ${frags.length} комірок за ${Date.now() - started}мс`,
    );
    // null → «не можу дати текст», викликач іде далі ланцюжком (контракт TextLayerProvider).
    return frags.length ? frags : null;
  }

  private async recognizePage(
    png: Buffer,
    heightPx: number | undefined,
    budgetMs: number,
  ): Promise<OcrPage> {
    const timeout = Math.max(1_000, Math.min(PER_PAGE_TIMEOUT_MS, budgetMs));
    try {
      const { data } = await enqueue(async () => {
        const worker = await getWorker();
        return withTimeout(
          worker.recognize(png, {}, { blocks: true }),
          timeout,
          'ocr page timeout',
        );
      });
      const words = collectWords(data.blocks ?? []);
      // Висота растру: для PDF знаємо точно, для фото беремо з нижньої межі найнижчого слова.
      const height = heightPx ?? words.reduce((m, w) => Math.max(m, w.bbox.y1), 0);
      return { words, height };
    } catch (e) {
      if (e instanceof OcrTimeoutError) {
        // Переможений recognize далі тримає воркер — без скидання наступні запити стануть
        // у чергу за зависшим і теж впадуть по таймауту (каскад).
        await disposeOcrWorker();
      }
      throw e;
    }
  }
}

/** Єдиний інстанс: кеш воркера модульний, але singleton прозоріший за new на кожен виклик. */
export const OCR_PROVIDER = new OcrTextLayerProvider();

/** Власник lifecycle воркера: без terminate на shutdown worker_threads не дасть процесу вийти. */
@Injectable()
export class OcrWorkerLifecycle implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await disposeOcrWorker();
  }
}
