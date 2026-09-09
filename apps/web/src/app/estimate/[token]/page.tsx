'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { publicFetch } from '@/lib/api-client';

interface EstimateLine {
  id: string;
  workName?: string;
  normoHours: number;
  price: number;
  amount: number;
  notes?: string | null;
}

interface EstimatePart {
  id: string;
  goodName?: string;
  quantity: number;
  unitShortName?: string;
  price: number;
  amount: number;
}

interface EstimateData {
  number: string;
  status: string;
  orgName?: string;
  orgLogoUrl?: string | null;
  branchName?: string;
  counterpartyName?: string;
  vehicleSummary?: string;
  documentDate?: string | null;
  description?: string | null;
  inMileage?: number | null;
  totalLabor: number;
  totalParts: number;
  totalAmount: number;
  lines: EstimateLine[];
  parts: EstimatePart[];
}

// Public widget — module-level Intl singletons.
const MONEY_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INT_FMT = new Intl.NumberFormat('uk-UA');
const DATE_FMT = new Intl.DateTimeFormat('uk-UA');

function fmt(n: number) {
  return MONEY_FMT.format(n);
}

export default function EstimatePage() {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const token = params?.token ?? '';
  const autoPrint = searchParams?.get('print') === '1';

  const [data, setData] = useState<EstimateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    publicFetch<EstimateData>(`/public/work-orders/${encodeURIComponent(token)}`)
      .then(d => {
        if (!cancelled) setData(d);
      })
      .catch(e => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Помилка';
        setError(/HTTP 404|не дійсне|термін дії минув/i.test(msg) ? 'not_found' : msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Auto-trigger print dialog after data loads when ?print=1
  useEffect(() => {
    if (!autoPrint || !data) return;
    // Small delay so images (logo) can load before print dialog opens
    const id = setTimeout(() => window.print(), 600);
    return () => clearTimeout(id);
  }, [autoPrint, data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 text-center px-4">
        <p className="text-xl font-semibold text-gray-700">
          {error === 'not_found'
            ? 'Посилання не дійсне або термін дії минув'
            : 'Не вдалося завантажити кошторис'}
        </p>
        {error && error !== 'not_found' && <p className="text-sm text-gray-500">{error}</p>}
      </div>
    );
  }

  const docDate = data.documentDate
    ? DATE_FMT.format(new Date(data.documentDate))
    : DATE_FMT.format(new Date());

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { font-size: 11pt; color: #000; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>

      <div className="max-w-3xl mx-auto p-6 font-sans text-gray-900 text-sm">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            {data.orgLogoUrl && (
              // раст-логотип org за довільним URL — next/image тут не підходить; звичайний <img>
              <img
                src={data.orgLogoUrl}
                alt={data.orgName ?? 'Логотип'}
                className="h-14 w-auto object-contain"
                onError={e => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <div>
              {data.orgName && (
                <p className="text-base font-semibold text-gray-700">{data.orgName}</p>
              )}
              <h1 className="text-2xl font-bold">Кошторис {data.number}</h1>
              {data.branchName && <p className="text-gray-500 mt-0.5">{data.branchName}</p>}
            </div>
          </div>
          <button
            onClick={() => window.print()}
            className="no-print flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shrink-0"
          >
            <Printer size={16} />
            Надрукувати
          </button>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 mb-6 border rounded-lg p-4 bg-gray-50">
          {data.counterpartyName && (
            <>
              <span className="text-gray-500">Клієнт</span>
              <span className="font-medium">{data.counterpartyName}</span>
            </>
          )}
          {data.vehicleSummary && (
            <>
              <span className="text-gray-500">Автомобіль</span>
              <span className="font-medium">{data.vehicleSummary}</span>
            </>
          )}
          {data.inMileage != null && (
            <>
              <span className="text-gray-500">Пробіг при прийомі</span>
              <span className="font-medium">{INT_FMT.format(data.inMileage)} км</span>
            </>
          )}
          <span className="text-gray-500">Дата</span>
          <span className="font-medium">{docDate}</span>
        </div>

        {data.description && (
          <div className="mb-6 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
            <span className="font-medium">Примітка: </span>
            {data.description}
          </div>
        )}

        {/* Works */}
        {data.lines.length > 0 && (
          <div className="mb-6">
            <h2 className="font-semibold text-base mb-2">Роботи</h2>
            <table className="w-full border-collapse text-sm">
              <colgroup>
                <col />
                <col className="w-20" />
                <col className="w-24" />
                <col className="w-24" />
              </colgroup>
              <thead>
                <tr className="border-b border-gray-300 bg-gray-50">
                  <th className="text-left py-2 px-2 font-medium">Назва</th>
                  <th className="text-right py-2 px-2 font-medium">Н/год</th>
                  <th className="text-right py-2 px-2 font-medium">Ціна</th>
                  <th className="text-right py-2 px-2 font-medium">Сума</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line, i) => (
                  <tr key={line.id} className={i % 2 === 0 ? '' : 'bg-gray-50'}>
                    <td className="py-1.5 px-2">
                      {line.workName ?? '—'}
                      {line.notes && (
                        <span className="text-gray-400 text-xs ml-2">({line.notes})</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{line.normoHours}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmt(line.price)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium">
                      {fmt(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-300">
                  <td colSpan={3} className="py-2 px-2 text-right font-medium text-gray-600">
                    Разом роботи:
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">
                    {fmt(data.totalLabor)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Parts */}
        {data.parts.length > 0 && (
          <div className="mb-6">
            <h2 className="font-semibold text-base mb-2">Запчастини та матеріали</h2>
            <table className="w-full border-collapse text-sm">
              <colgroup>
                <col />
                <col className="w-20" />
                <col className="w-16" />
                <col className="w-24" />
                <col className="w-24" />
              </colgroup>
              <thead>
                <tr className="border-b border-gray-300 bg-gray-50">
                  <th className="text-left py-2 px-2 font-medium">Назва</th>
                  <th className="text-right py-2 px-2 font-medium">Кількість</th>
                  <th className="text-right py-2 px-2 font-medium">Од.</th>
                  <th className="text-right py-2 px-2 font-medium">Ціна</th>
                  <th className="text-right py-2 px-2 font-medium">Сума</th>
                </tr>
              </thead>
              <tbody>
                {data.parts.map((part, i) => (
                  <tr key={part.id} className={i % 2 === 0 ? '' : 'bg-gray-50'}>
                    <td className="py-1.5 px-2">{part.goodName ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{part.quantity}</td>
                    <td className="py-1.5 px-2 text-right text-gray-500">
                      {part.unitShortName ?? ''}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmt(part.price)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium">
                      {fmt(part.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-300">
                  <td colSpan={4} className="py-2 px-2 text-right font-medium text-gray-600">
                    Разом запчастини:
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">
                    {fmt(data.totalParts)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Total */}
        <div className="border-t-2 border-gray-800 pt-4 flex justify-end">
          <div className="text-right">
            <div className="text-base font-medium text-gray-600">Загальна сума:</div>
            <div className="text-2xl font-bold">{fmt(data.totalAmount)} ₴</div>
          </div>
        </div>

        {/* Footer note */}
        <div className="mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400 text-center no-print">
          Цей документ є попереднім кошторисом і не є рахунком-фактурою.
        </div>
      </div>
    </>
  );
}
