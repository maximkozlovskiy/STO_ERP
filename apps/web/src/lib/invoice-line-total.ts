import { lineAmount, roundMoney } from '@/lib/utils';

/** Рядок картки рахунку, як його бачить прев'ю суми. */
export interface InvoicePreviewLine {
  id?: string;
  quantity: string | number;
  unitPrice: string | number;
  /** Сума рядка з ПДВ від сервера (WEB-R3-4); новий ручний рядок — без неї. */
  lineTotalWithVat?: number;
}

/**
 * Сума рядка для прев'ю картки рахунку (BR-INV-017, BR-INV-024).
 * - Новий рядок — кількість × ціна без ПДВ (сервер додасть ПДВ при збереженні).
 * - Збережений незмінений — сума з ПДВ від сервера як є (EXCLUSIVE не занижується, INCLUSIVE не
 *   подвоюється).
 * - Збережений, якому змінили кількість чи ціну, — серверна сума з ПДВ пропорційно новій сумі без
 *   ПДВ: ставка рядка та сама (`updateLine` її не міняє), тож ПДВ росте разом із сумою. Серверна
 *   сума без ПДВ нуль (ціна 0) — пропорції немає, показуємо кількість × ціна.
 * @param serverNet сума без ПДВ кожного збереженого рядка станом на завантаження (id → сума).
 */
export function linePreviewTotal(
  line: InvoicePreviewLine,
  serverNet: ReadonlyMap<string, number>,
): number {
  const net = lineAmount(
    parseFloat(String(line.quantity)) || 0,
    parseFloat(String(line.unitPrice)) || 0,
  );
  const withVat = line.lineTotalWithVat;
  if (withVat == null) return net;
  const base = line.id ? serverNet.get(line.id) : undefined;
  if (base == null || base === net) return withVat;
  return base > 0 ? roundMoney((withVat * net) / base) : net;
}
