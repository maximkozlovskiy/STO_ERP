/**
 * Постачальник текстового шару сторінкового документа.
 *
 * МЕЖА ДЛЯ МАЙБУТНЬОГО OCR: `fragmentsToGrid` (pdf-grid.extractor.ts) приймає `TextFragment[]` і
 * нічого не знає про джерело. OCR-рушій (Tesseract тощо) віддає рівно те саме — текст + bounding
 * box, — тож додавання OCR = НОВИЙ ФАЙЛ `ocr-text-layer.provider.ts` + один елемент у масив
 * провайдерів у DocumentGridParserService. Без змін у сітці, мапінгу, контролері, DTO та UI.
 */

/** Текстовий фрагмент із геометрією. Координати — у просторі сторінки, y зростає ВГОРУ (PDF). */
export interface TextFragment {
  str: string;
  /** Ліва межа фрагмента. */
  x: number;
  /** Baseline фрагмента. Для багатосторінкових документів — вже зі зсувом по сторінці. */
  y: number;
  /** Ширина фрагмента. */
  w: number;
  /** Висота фрагмента (0 для службових whitespace-елементів). */
  h: number;
}

export interface ExtractOpts {
  /** Захист від 500-сторінкового каталогу в межах 10 MB ліміту завантаження. */
  maxPages?: number;
}

export interface TextLayerProvider {
  readonly name: 'pdfjs' | 'ocr';
  /**
   * Повертає фрагменти або `null`, якщо цей провайдер не може дати текст (напр. pdfjs на скані) —
   * тоді викликач пробує наступного провайдера у ланцюжку.
   */
  extract(buffer: Buffer | Uint8Array, opts?: ExtractOpts): Promise<TextFragment[] | null>;
}
