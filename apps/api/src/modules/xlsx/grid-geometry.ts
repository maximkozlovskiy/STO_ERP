import type { TextFragment } from './text-layer.provider';

/**
 * Геометрія текстової сітки — спільний фундамент для ВСІХ постачальників тексту.
 *
 * Винесено в окремий модуль, щоб розірвати цикл імпортів: `pdf-grid.extractor` тримає реєстр
 * провайдерів (а отже знає про OCR), тоді як OCR-провайдеру потрібні лише ці геометричні
 * функції. Поки вони жили в екстракторі, виходило ocr ↔ pdf-grid.extractor (знайдено madge).
 * Тут модуль не залежить ні від pdfjs, ні від OCR — цикл неможливий за побудовою.
 */

/**
 * Зсув y на сторінку: координати різних сторінок перетинаються (кожна починає відлік від свого
 * низу), тож без зсуву рядки різних сторінок злились би в один при Y-групуванні.
 */
export const PAGE_Y_OFFSET = 100_000;
/** Медіана (для непарного — середній, для парного — нижній середній; точність тут не критична). */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export interface GridLine {
  y: number;
  items: TextFragment[];
}

/**
 * Медіанна висота фрагментів — базова одиниця всіх допусків сітки. Повертає 10 як запасний
 * розмір, якщо жоден фрагмент не має висоти (деякі PDF віддають h=0 для whitespace).
 */
export function medianFragmentHeight(frags: readonly TextFragment[]): number {
  return median(frags.map(f => f.h).filter(h => h > 0)) || 10;
}

/**
 * Групування фрагментів у рядки за y — крок 3 алгоритму сітки, ВИНЕСЕНИЙ сюди як єдине джерело
 * правди. `mergeWordsIntoCells` (OCR) мусить групувати рядки ТОЧНО так само, як `fragmentsToGrid`:
 * інакше слова зіллються по межах одного набору рядків, а в колонки розкладуться по межах іншого —
 * і сітка поїде ТИХО, без жодної помилки. Тримати допуск `medH * 0.5` у двох файлах означало
 * покладатись на те, що правку в одному не забудуть продублювати в другому.
 *
 * Сортування: y спадає (PDF-координати зростають вгору, а рядки документа йдуть зверху вниз),
 * всередині рядка — x зростає.
 */
export function groupFragmentsIntoLines(frags: readonly TextFragment[], medH: number): GridLine[] {
  const yTol = medH * 0.5;
  const lines: GridLine[] = [];
  for (const f of [...frags].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l.y - f.y) <= yTol);
    if (line) line.items.push(f);
    else lines.push({ y: f.y, items: [f] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}
