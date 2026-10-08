import type { VatMode } from '@prisma/client';
import { calcLineVat } from '../../common/utils/vat';
import { money } from '../../common/utils/money';

/**
 * BR-INV-002: рядки рахунку з наряду. Чиста функція — без БД, щоб правило «сума рахунку =
 * сума наряду» перевірялось на числах, а не на моках транзакції.
 *
 * Джерело правди — НАРЯД: його `totalAmount` уже нараховано клієнтові боргом (CHARGE при
 * COMPLETED), тож рахунок мусить вийти рівно на цю суму, а не на перераховану з рядків.
 * Звідси два наслідки:
 *
 * 1. Режим ПДВ береться з тоталів наряду, а не з поточних налаштувань. Наряд, завершений до
 *    BR-WO-007 в організації «ПДВ зверху», має `totalNet = totalAmount` (ПДВ клієнтові не
 *    нараховували) — рахунок по ньому виходить без ПДВ, хоч налаштування кажуть інакше.
 * 2. Наряд рахує ПДВ від суми, рядки — кожен від себе, тому підсумки можуть розійтись на
 *    копійки. Різницю забирає останній рядок. Якщо вона більша за копійку на рядок — це вже не
 *    округлення, а наряд, чиї тотали не відповідають рядкам: помилка, а не вирівнювання.
 */
export interface WorkOrderForInvoice {
  totalNet: number;
  totalAmount: number;
  lines: {
    workId: string | null;
    name: string | null;
    quantity: number;
    unitPrice: number;
  }[];
  parts: {
    goodId: string | null;
    name: string | null;
    quantity: number;
    unitPrice: number;
  }[];
}

export interface InvoiceLineDraft {
  workId?: string | null;
  goodId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  priceWithoutVat: number;
  vatAmount: number;
  priceWithVat: number;
  sortOrder: number;
}

export class WorkOrderTotalsMismatchError extends Error {
  constructor(readonly detail: string) {
    super(`Тотали наряду не відповідають його рядкам: ${detail}`);
  }
}

const KOPECK = 0.01;
// Пів копійки запасу на float: порівнюємо вже округлені суми, але різниця двох Money — float.
const EPS = 0.005;

function effectiveMode(
  wo: WorkOrderForInvoice,
  base: number,
  tolerance: number,
  settingsMode: VatMode,
): VatMode {
  const vat = money(wo.totalAmount - wo.totalNet);
  if (vat === 0) {
    if (Math.abs(wo.totalAmount - base) > tolerance)
      throw new WorkOrderTotalsMismatchError(`сума наряду ${wo.totalAmount}, сума рядків ${base}`);
    return 'NONE';
  }
  // Сума рядків збігається з сумою без ПДВ → «ПДВ зверху»; із сумою до сплати → «ПДВ у ціні».
  // На копійчаних нарядах обидві різниці влазять у допуск (ПДВ наряду менший за копійку на
  // рядок), тому беремо БЛИЖЧУ, а не першу: інакше наряд «ПДВ у ціні» на 0.60 читався як
  // «ПДВ зверху», і останній рядок рахунку виходив від'ємним. За рівності — режим налаштувань.
  const toNet = Math.abs(wo.totalNet - base);
  const toTotal = Math.abs(wo.totalAmount - base);
  if (toNet > tolerance && toTotal > tolerance)
    throw new WorkOrderTotalsMismatchError(
      `сума без ПДВ ${wo.totalNet}, до сплати ${wo.totalAmount}, сума рядків ${base}`,
    );
  if (Math.abs(toNet - toTotal) < EPS)
    return settingsMode === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
  return toNet < toTotal ? 'EXCLUSIVE' : 'INCLUSIVE';
}

function draft(wo: WorkOrderForInvoice, vatRate: number, vatMode: VatMode): InvoiceLineDraft[] {
  const rate = vatMode === 'NONE' ? 0 : vatRate;
  const one = (sum: number) => {
    const v = calcLineVat(sum, 1, rate, vatMode);
    // Тотожність рядка тримаємо явно: calcLineVat округлює три величини незалежно.
    return vatMode === 'INCLUSIVE'
      ? {
          priceWithVat: v.priceWithVat,
          vatAmount: v.vatAmount,
          priceWithoutVat: money(v.priceWithVat - v.vatAmount),
        }
      : {
          priceWithoutVat: v.priceWithoutVat,
          vatAmount: v.vatAmount,
          priceWithVat: money(v.priceWithoutVat + v.vatAmount),
        };
  };
  return [
    ...wo.lines.map((l, i) => ({
      workId: l.workId,
      description: l.name ?? 'Робота',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vatRate: rate,
      ...one(l.quantity * l.unitPrice),
      sortOrder: i,
    })),
    ...wo.parts.map((p, i) => ({
      goodId: p.goodId,
      description: p.name ?? 'Запчастина',
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      vatRate: rate,
      ...one(p.quantity * p.unitPrice),
      sortOrder: wo.lines.length + i,
    })),
  ];
}

/** Різниці «наряд − Σ рядків» по сумі без ПДВ і по ПДВ. */
function gaps(wo: WorkOrderForInvoice, lines: InvoiceLineDraft[]) {
  let net = 0;
  let vat = 0;
  for (const l of lines) {
    net += l.priceWithoutVat;
    vat += l.vatAmount;
  }
  return {
    net: money(wo.totalNet - net),
    vat: money(money(wo.totalAmount - wo.totalNet) - vat),
  };
}

/**
 * Residual kopecks go to the last line, as BR-INV-002 says, unless that line cannot hold them:
 * a zero line (work with 0 actual hours) or a line whose own VAT rounds to zero would come out
 * negative on the invoice. Then the nearest earlier non-zero line that stays non-negative takes
 * the residual. If no line qualifies, the last one keeps it (totals must match the work order).
 */
function residualTarget(
  lines: InvoiceLineDraft[],
  gap: { net: number; vat: number },
): InvoiceLineDraft | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (
      l &&
      l.priceWithoutVat > 0 &&
      money(l.priceWithoutVat + gap.net) >= 0 &&
      money(l.vatAmount + gap.vat) >= 0
    )
      return l;
  }
  return lines[lines.length - 1];
}

export function buildInvoiceLinesFromWorkOrder(
  wo: WorkOrderForInvoice,
  settingsVat: { vatMode: VatMode; vatRate: number },
): InvoiceLineDraft[] {
  const count = wo.lines.length + wo.parts.length;
  const tolerance = count * KOPECK + EPS;
  let rawBase = 0;
  for (const l of wo.lines) rawBase += l.quantity * l.unitPrice;
  for (const p of wo.parts) rawBase += p.quantity * p.unitPrice;
  const base = money(rawBase);

  const vatMode = effectiveMode(wo, base, tolerance, settingsVat.vatMode);
  if (count === 0) return [];

  // Ставка: з налаштувань; якщо з нею рядки не сходяться з нарядом (ставку змінили після
  // завершення наряду або ПДВ в організації вимкнули) — та, що випливає з самого наряду.
  const derivedRate =
    wo.totalNet > 0 ? money(((wo.totalAmount - wo.totalNet) / wo.totalNet) * 100) : 0;
  const candidates =
    vatMode === 'NONE'
      ? [0]
      : settingsVat.vatMode !== 'NONE' && settingsVat.vatRate > 0
        ? [settingsVat.vatRate, derivedRate]
        : [derivedRate];

  let lastGap = { net: 0, vat: 0 };
  for (const rate of candidates) {
    const lines = draft(wo, rate, vatMode);
    const gap = gaps(wo, lines);
    lastGap = gap;
    if (Math.abs(gap.net) > tolerance || Math.abs(gap.vat) > tolerance) continue;

    if (gap.net !== 0 || gap.vat !== 0) {
      const target = residualTarget(lines, gap);
      if (target) {
        target.priceWithoutVat = money(target.priceWithoutVat + gap.net);
        target.vatAmount = money(target.vatAmount + gap.vat);
        target.priceWithVat = money(target.priceWithoutVat + target.vatAmount);
      }
    }
    return lines;
  }
  throw new WorkOrderTotalsMismatchError(
    `розбіжність із рядками: без ПДВ ${lastGap.net}, ПДВ ${lastGap.vat} — понад копійку на рядок`,
  );
}
