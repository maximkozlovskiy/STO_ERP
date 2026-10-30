import { lineAmount, roundMoney } from '@/lib/utils';

/** Рядок картки рахунку, як його бачить прев'ю суми. */
export interface InvoicePreviewLine {
  id?: string;
  quantity: string | number;
  unitPrice: string | number;
  /** Сума рядка з ПДВ від сервера (WEB-R3-4); новий ручний рядок — без неї. */
  lineTotalWithVat?: number;
  /** Ставка ПДВ рядка від сервера, % (`updateLine` її не міняє). */
  vatRate?: number;
}

/**
 * Сума рядка для прев'ю картки рахунку (BR-INV-017, BR-INV-024).
 * - Новий рядок — кількість × ціна без ПДВ (сервер додасть ПДВ при збереженні).
 * - Збережений незмінений — сума з ПДВ від сервера як є (EXCLUSIVE не занижується, INCLUSIVE не
 *   подвоюється).
 * - Збережений, якому змінили кількість чи ціну, — як порахує `updateLine` (`manualLineVat`): сума з
 *   ПДВ дорівнювала сумі рядка («ПДВ у ціні» чи без ПДВ) — нова сума рядка; інакше («ПДВ зверху»)
 *   нова сума + ПДВ за ставкою рядка, округлений до копійки окремо. Пропорція «стара сума з ПДВ ×
 *   нова ÷ стара» розходилась із сервером на копійку: 0,3 × 111,11 = 33,33 → 40,00, ціна 200 →
 *   прев'ю 72,01 при збереженому 72,00 (клас Bug #811). Без ставки — пропорція, як запас.
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
  // ПДВ у ціні або без ПДВ: сума з ПДВ і є сумою рядка.
  if (Math.abs(withVat - base) < 0.005) return net;
  if (line.vatRate != null && Number.isFinite(line.vatRate)) {
    return roundMoney(net + roundMoney((net * line.vatRate) / 100));
  }
  return base > 0 ? roundMoney((withVat * net) / base) : net;
}
