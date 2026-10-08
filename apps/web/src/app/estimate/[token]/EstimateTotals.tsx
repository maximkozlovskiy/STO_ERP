import { workOrderVatSplit } from '@/lib/utils';

// Public widget — module-level Intl singleton.
const MONEY_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Підсумок публічного кошторису (BR-WO-007): `totalAmount` — планова сума до сплати з ПДВ.
 * Коли ПДВ у сумі є — три рядки «Сума без ПДВ / ПДВ / Разом до сплати», інакше — одна сума.
 */
export function EstimateTotals({
  totalAmount,
  totalNet,
}: {
  totalAmount: number;
  totalNet?: number | null;
}) {
  const split = workOrderVatSplit({ totalAmount, totalNet });
  if (split.vat <= 0) {
    return (
      <div className="border-t-2 border-gray-800 pt-4 flex justify-end">
        <div className="text-right">
          <div className="text-base font-medium text-gray-600">Загальна сума:</div>
          <div className="text-2xl font-bold tabular-nums">{MONEY_FMT.format(split.gross)} ₴</div>
        </div>
      </div>
    );
  }
  return (
    <div className="border-t-2 border-gray-800 pt-4 flex justify-end">
      <dl className="w-full max-w-xs space-y-1" data-testid="estimate-vat-totals">
        <div className="flex items-baseline justify-between gap-6 text-sm text-gray-600">
          <dt>Сума без ПДВ:</dt>
          <dd className="text-right tabular-nums">{MONEY_FMT.format(split.net)} ₴</dd>
        </div>
        <div className="flex items-baseline justify-between gap-6 text-sm text-gray-600">
          <dt>ПДВ:</dt>
          <dd className="text-right tabular-nums">{MONEY_FMT.format(split.vat)} ₴</dd>
        </div>
        <div className="flex items-baseline justify-between gap-6 border-t border-gray-300 pt-2">
          <dt className="text-base font-medium text-gray-600">Разом до сплати:</dt>
          <dd className="text-right text-2xl font-bold tabular-nums">
            {MONEY_FMT.format(split.gross)} ₴
          </dd>
        </div>
      </dl>
    </div>
  );
}
