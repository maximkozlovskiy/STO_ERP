// Парсер призначення платежу (purpose) банківської виписки. Чистий модуль без залежностей —
// юніт-тестований ізольовано (purpose-parser.spec.ts). Використовується bank-reconciliation.service
// для авто-матчу вхідних банк-транзакцій до Invoice / WorkOrder за текстом призначення.

export interface ParsedPurpose {
  /** Номер рахунку (Invoice.number), витягнутий із «рахунок №…». */
  invoiceNumber?: string;
  /** Номер наряду (WorkOrder.number), витягнутий із «наряд №…» або «WO-…». */
  workOrderNumber?: string;
  /** Підказка типу рознесення за ключовими словами (аванс → PREPAYMENT, повернення → REFUND). */
  hint?: 'PREPAYMENT' | 'REFUND';
}

// Регекси винесені у module-scope (компілюються один раз, не на кожен виклик parsePurpose).
// «рахун[а-я]*» покриває «рахунок/рахунку/рахунком/рахунків»; роздільник — пробіли/№/#/:/крапка.
// Група коду: латиниця+кирилиця-цифри-дефіс-слеш (номери документів на кшталт «INV-2026/07»).
const INVOICE_RE = /рахун[а-яіїєґ]*[\s№#:.]*([A-Za-z0-9\-/]+)/iu;
// «наряд[а-я]*» покриває «наряд/наряду/нарядом/нарядів/наряд-замовлення».
const WORK_ORDER_UA_RE = /наряд[а-яіїєґ]*[\s№#:.-]*([0-9][A-Za-z0-9\-/]*)/iu;
// Латинський короткий формат «WO-123», «WO 123», «WO№123».
const WORK_ORDER_LAT_RE = /\bWO[\s\-№#:]*([0-9][0-9\-/]*)/i;
// Підказки за ключовими словами (не залежать від номерів).
const PREPAYMENT_RE = /(аванс|передоплат|предоплат)/iu;
const REFUND_RE = /(поверн|возврат)/iu;

/**
 * Розбирає призначення платежу на структуровані підказки для авто-матчу.
 * Порожній/невизначений вхід → порожній результат (усі поля undefined). Ніколи не кидає.
 */
export function parsePurpose(purpose: string | null | undefined): ParsedPurpose {
  const result: ParsedPurpose = {};
  if (!purpose || typeof purpose !== 'string') return result;
  const text = purpose.trim();
  if (!text) return result;

  const invoiceMatch = INVOICE_RE.exec(text);
  if (invoiceMatch?.[1]) result.invoiceNumber = invoiceMatch[1].trim();

  // Наряд: спочатку латинський WO-формат (специфічніший), потім українське «наряд».
  const woLat = WORK_ORDER_LAT_RE.exec(text);
  if (woLat?.[1]) {
    result.workOrderNumber = woLat[1].trim();
  } else {
    const woUa = WORK_ORDER_UA_RE.exec(text);
    if (woUa?.[1]) result.workOrderNumber = woUa[1].trim();
  }

  if (PREPAYMENT_RE.test(text)) result.hint = 'PREPAYMENT';
  else if (REFUND_RE.test(text)) result.hint = 'REFUND';

  return result;
}
