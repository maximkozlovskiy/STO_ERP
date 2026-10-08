'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { HandCoins, Search, RotateCw } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { usePayments, useRetryFiscal, type PaymentsFilter } from '@/hooks/api/usePayments';
import { useBaseCurrency } from '@/hooks/api/useCash';
import { FISCAL_STATUS_LABELS, FISCAL_STATUS_BADGE, FISCAL_STATUS_DESCRIPTIONS } from '@sto/shared';
import { fiscalStatusLabel, paymentSourceTypeLabel } from '@/i18n/enumLabel';
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
import { useDebounce } from '@/hooks/useDebounce';

const LIMIT = 20;

// Фіскальний бейдж: null → «—» (метод без фіскалізації).
function FiscalBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant={FISCAL_STATUS_BADGE[status] ?? 'secondary'}
      tooltip={FISCAL_STATUS_DESCRIPTIONS[status]}
    >
      {fiscalStatusLabel(status)}
    </Badge>
  );
}

function PaymentsPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const router = useRouter();
  const { t } = useTranslation('payments');

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
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
    q: debouncedSearch.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    method: method || undefined,
    fiscalStatus: fiscalStatus || undefined,
  };
  const { data, isLoading } = usePayments(filters);
  const retryFiscal = useRetryFiscal();
  // Мультивалюта: символ базової валюти для рядка «у базовій» (не-базові оплати).
  const { data: baseCurrency } = useBaseCurrency();
  const baseCode = baseCurrency?.code ?? 'UAH';
  const baseSymbol = baseCurrency?.symbol ?? '₴';

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
      toast.success(t('toast.retryQueued'));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('toast.retryError'));
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
      <h1 className="page-title mb-6">{t('page.title')}</h1>

      {/* Фільтри */}
      <div className="flex flex-wrap items-center gap-3 shrink-0 mb-4">
        <Input
          value={search}
          onChange={e => resetPageAnd(() => setSearch(e.target.value))}
          placeholder={t('page.filters.searchPlaceholder')}
          aria-label={t('page.filters.searchPlaceholder')}
          leftElement={<Search />}
          className="w-64 h-8 text-[13px]"
        />
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">
            {t('page.filters.dateFrom')}
          </span>
          <DatePickerInput
            value={dateFrom}
            onChange={v => resetPageAnd(() => setDateFrom(v))}
            max={dateTo || undefined}
            className="w-36"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">
            {t('page.filters.dateTo')}
          </span>
          <DatePickerInput
            value={dateTo}
            onChange={v => resetPageAnd(() => setDateTo(v))}
            min={dateFrom || undefined}
            className="w-36"
          />
        </div>
        <div className="w-48">
          <Select
            aria-label={t('page.filters.method')}
            value={method}
            onChange={e => resetPageAnd(() => setMethod(e.target.value))}
            className="h-8 text-[13px]"
          >
            <option value="">{t('page.filters.allMethods')}</option>
            {methods.map(m => (
              <option key={m.code} value={m.code}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {/* «Усі» без підпису не каже, усі ЩО — тому підпис лишається, але в рядок, як у дат. */}
          <span className="text-[13px] text-muted-foreground shrink-0">
            {t('page.filters.fiscalStatus')}
          </span>
          <Select
            aria-label={t('page.filters.fiscalStatus')}
            value={fiscalStatus}
            onChange={e => resetPageAnd(() => setFiscalStatus(e.target.value))}
            className="w-48 h-8 text-[13px]"
          >
            <option value="">{t('page.filters.all')}</option>
            {Object.keys(FISCAL_STATUS_LABELS).map(code => (
              <option key={code} value={code}>
                {fiscalStatusLabel(code)}
              </option>
            ))}
            <option value="none">{t('page.filters.noFiscal')}</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={HandCoins} title={t('page.empty.notFound')} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('page.columns.date')}</TableHead>
                  <TableHead>{t('page.columns.counterparty')}</TableHead>
                  <TableHead>{t('page.columns.method')}</TableHead>
                  <TableHead>{t('page.columns.source')}</TableHead>
                  <TableHead className="text-right">{t('page.columns.amount')}</TableHead>
                  <TableHead>{t('page.columns.receipt')}</TableHead>
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
                        ? `${paymentSourceTypeLabel(p.sourceType)}${p.sourceName ? ` · ${p.sourceName}` : ''}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(() => {
                        // Валюта оплати: код рядка або базовий символ (історичні/UAH).
                        const isBase = !p.currencyCode || p.currencyCode === baseCode;
                        const sym = isBase ? baseSymbol : p.currencyCode;
                        return (
                          <div className="flex flex-col items-end">
                            <span>
                              {fmtMoney(p.amount)} {sym}
                            </span>
                            {!isBase && p.amountBase != null && (
                              <span className="text-xs text-muted-foreground">
                                {fmtMoney(p.amountBase)} {baseSymbol}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
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
                          {t('page.actions.retry')}
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
