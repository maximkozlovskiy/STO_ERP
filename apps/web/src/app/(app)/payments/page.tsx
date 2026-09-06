'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HandCoins, Search, RotateCw } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { usePayments, useRetryFiscal, type PaymentsFilter } from '@/hooks/api/usePayments';
import {
  FISCAL_STATUS_LABELS,
  FISCAL_STATUS_BADGE,
  FISCAL_STATUS_DESCRIPTIONS,
  PAYMENT_SOURCE_TYPE_LABELS,
} from '@sto/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate } from '@/lib/format';

const LIMIT = 20;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

// Фіскальний бейдж: null → «—» (метод без фіскалізації).
function FiscalBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant={FISCAL_STATUS_BADGE[status] ?? 'secondary'}
      tooltip={FISCAL_STATUS_DESCRIPTIONS[status]}
    >
      {FISCAL_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function PaymentsPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const router = useRouter();

  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [method, setMethod] = useState('');
  const [fiscalStatus, setFiscalStatus] = useState('');
  const [methods, setMethods] = useState<{ code: string; name: string }[]>([]);
  // Per-row retry state: retryFiscal.isPending спільний для всіх рядків → без цього
  // клік по одній кнопці «Повторити» показав би loading на ВСІХ FAILED-кнопках одразу.
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const filters: PaymentsFilter = {
    page,
    limit: LIMIT,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    method: method || undefined,
    fiscalStatus: fiscalStatus || undefined,
  };
  const { data, isLoading } = usePayments(filters);
  const retryFiscal = useRetryFiscal();

  // Методи оплати для фільтра (best-effort; фолбек на порожньо).
  useEffect(() => {
    void import('@/lib/api-client').then(({ apiFetch }) =>
      apiFetch<{ items?: { code: string; name: string }[] } | { code: string; name: string }[]>(
        '/payment-methods',
      )
        .then(d => setMethods(Array.isArray(d) ? d : (d.items ?? [])))
        .catch(() => undefined),
    );
  }, []);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const onRetry = async (id: string) => {
    setRetryingId(id);
    try {
      await retryFiscal.mutateAsync(id);
      toast.success('Фіскалізацію поставлено в чергу повторно');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка повтору');
    } finally {
      setRetryingId(null);
    }
  };

  const resetPageAnd = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <h1 className="page-title mb-6">Оплати клієнтів</h1>

      {/* Фільтри */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-40">
          <DatePickerInput
            label="Від"
            value={dateFrom}
            onChange={v => resetPageAnd(() => setDateFrom(v))}
          />
        </div>
        <div className="w-40">
          <DatePickerInput
            label="До"
            value={dateTo}
            onChange={v => resetPageAnd(() => setDateTo(v))}
          />
        </div>
        <div className="w-48">
          <Select
            label="Метод"
            value={method}
            onChange={e => resetPageAnd(() => setMethod(e.target.value))}
          >
            <option value="">Усі методи</option>
            {methods.map(m => (
              <option key={m.code} value={m.code}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-48">
          <Select
            label="Фіскальний статус"
            value={fiscalStatus}
            onChange={e => resetPageAnd(() => setFiscalStatus(e.target.value))}
          >
            <option value="">Усі</option>
            {Object.entries(FISCAL_STATUS_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            <option value="none">Без фіскалізації</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={HandCoins} title="Платежів не знайдено" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата</TableHead>
                  <TableHead>Контрагент</TableHead>
                  <TableHead>Метод</TableHead>
                  <TableHead>Рахунок</TableHead>
                  <TableHead className="text-right">Сума</TableHead>
                  <TableHead>Чек (ПРРО)</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(p => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/payments/${p.id}`)}
                  >
                    <TableCell>{fmtDate(p.createdAt)}</TableCell>
                    <TableCell>{p.counterpartyName ?? '—'}</TableCell>
                    <TableCell>{p.method}</TableCell>
                    <TableCell>
                      {p.sourceType
                        ? `${PAYMENT_SOURCE_TYPE_LABELS[p.sourceType] ?? p.sourceType}${p.sourceName ? ` · ${p.sourceName}` : ''}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.amount)}</TableCell>
                    <TableCell>
                      <FiscalBadge status={p.fiscalStatus} />
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      {p.fiscalStatus === 'FAILED' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void onRetry(p.id)}
                          loading={retryingId === p.id}
                        >
                          <RotateCw className="h-3.5 w-3.5 mr-1" />
                          Повторити
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4">
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </div>
        </>
      )}
    </div>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      }
    >
      <PaymentsPageInner />
    </Suspense>
  );
}
