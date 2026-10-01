import { PAGE_Y_OFFSET } from './pdf-grid.extractor';
import type { TextFragment } from './text-layer.provider';

/** OCR відпрацював, але слів не знайшов (порожнє/надто шумне зображення). */
export class OcrNoTextError extends Error {}
/** OCR не вклався у бюджет часу. */
export class OcrTimeoutError extends Error {}
/** Моделі розпізнавання не знайдені на диску (битий образ / забутий COPY у Dockerfile). */
export class OcrModelsMissingError extends Error {}
/** Растеризація PDF недоступна (немає @napi-rs/canvas). Лише PDF-гілка; фото працюють. */
export class RasterizeUnavailableError extends Error {}

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

  const heights = frags.map(f => f.h).filter(h => h > 0);
  const medH = heights.length
    ? [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)]!
    : 10;
  const yTol = medH * 0.5;
  const maxGap = medH * gapRatio;

  // Групування в рядки — дзеркалить крок 3 fragmentsToGrid (той самий допуск).
  const lines: { y: number; items: TextFragment[] }[] = [];
  for (const f of [...frags].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l.y - f.y) <= yTol);
    if (line) line.items.push(f);
    else lines.push({ y: f.y, items: [f] });
  }

  const out: TextFragment[] = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
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
