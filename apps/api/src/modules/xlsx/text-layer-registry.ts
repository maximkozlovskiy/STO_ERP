import type { ExtractOpts, TextLayerProvider } from './text-layer.provider';
import { PdfjsTextLayerProvider, PdfScannedError, fragmentsToGrid } from './pdf-grid.extractor';
import { OCR_PROVIDER } from './ocr-text-layer.provider';

/**
 * Реєстр постачальників тексту + точка входу `pdfToGrid`.
 *
 * Окремий модуль навмисно: реєстр — ЄДИНЕ місце, що має знати одночасно і про pdfjs, і про
 * OCR. Поки він жив у `pdf-grid.extractor`, виходив цикл ocr → pdf-rasterizer →
 * pdf-grid.extractor → ocr (знайдено madge при вмиканні детектора). Тепер залежності
 * односторонні: механіка (extractor, rasterizer, geometry) нічого не знає про реєстр,
 * реєстр знає про всіх.
 */

/**
 * Ланцюжок постачальників тексту. Порядок важливий: спершу ДЕШЕВИЙ і ТОЧНИЙ текстовий шар
 * (мілісекунди), і лише якщо його немає — дороге й приблизне OCR (секунди).
 */
export const TEXT_LAYER_PROVIDERS: readonly TextLayerProvider[] = [
  new PdfjsTextLayerProvider(),
  OCR_PROVIDER,
];

/** Сітка + звідки взявся текст: UI попереджає про приблизність лише для OCR. */
export interface GridFromProvider {
  rows: string[][];
  provider: TextLayerProvider['name'];
}

/**
 * PDF → сітка. Перебирає провайдерів; перший, що дав текст, виграє. Якщо жоден не дав —
 * PdfScannedError (тобто ні текстового шару, ні слів на зображенні).
 *
 * Помилки провайдера НЕ ковтаємо: битий PDF має дати «файл пошкоджений», а не «скан без тексту».
 */
export async function pdfToGrid(
  buffer: Buffer | Uint8Array,
  opts?: ExtractOpts,
): Promise<GridFromProvider> {
  for (const provider of TEXT_LAYER_PROVIDERS) {
    const frags = await provider.extract(buffer, opts);
    if (frags?.length) return { rows: fragmentsToGrid(frags), provider: provider.name };
  }
  throw new PdfScannedError('no text layer');
}
