'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Landmark } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  useCashRegisters,
  useCreateCashRegister,
  useUpdateCashRegister,
  useDeleteCashRegister,
  type CashRegister,
} from '@/hooks/api/useCash';
import { type BranchInfo } from '../settings/shared';

interface CurrencyOpt {
  id: string;
  code: string;
}

interface FiscalProviderCfg {
  provider: string;
  enabled: boolean;
  hasCredentials: boolean;
}

// Людські назви ПРРО-провайдерів (дзеркалить FiscalTab FISCAL_PROVIDERS).
const FISCAL_PROVIDER_LABELS: Record<string, string> = {
  checkbox: 'Checkbox',
  vchasno: 'Вчасно.Каса',
};
const fiscalProviderLabel = (code?: string | null) =>
  code ? (FISCAL_PROVIDER_LABELS[code] ?? code) : '';

export default function CashRegistersTab({ canManage = false }: { canManage?: boolean }) {
  const { t } = useTranslation('cash');
  const { confirm, dialogProps } = useConfirm();
  const { data: registers, isLoading } = useCashRegisters();
  const createMut = useCreateCashRegister();
  const updateMut = useUpdateCashRegister();
  const deleteMut = useDeleteCashRegister();

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOpt[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CashRegister | null>(null);
  const [form, setForm] = useState({
    name: '',
    branchId: '',
    currencyId: '',
    isFiscal: false,
    fiscalProvider: '',
    providerCashRegisterId: '',
    initialBalance: '0',
  });
  const [error, setError] = useState('');
  // Налаштовані FISCAL-провайдери філії форми (для Select ПРРО у фіскальній касі).
  const [fiscalProviders, setFiscalProviders] = useState<FiscalProviderCfg[]>([]);

  useEffect(() => {
    const cb = getCached<BranchInfo[]>('cache:branches');
    if (cb?.length) setBranches(cb);
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
      })
      .catch(() => undefined);
    apiFetch<{ items: CurrencyOpt[] } | CurrencyOpt[]>('/currencies')
      .then(d => setCurrencies(Array.isArray(d) ? d : d.items))
      .catch(() => undefined);
  }, []);

  // Завантажити налаштовані FISCAL-провайдери філії форми (для прив'язки фіскальної каси до ПРРО).
  // Показуємо лише провайдерів з уведеними кредами (hasCredentials) — інакше касу не фіскалізувати.
  useEffect(() => {
    if (!modal || !form.branchId) {
      setFiscalProviders([]);
      return;
    }
    apiFetch<FiscalProviderCfg[]>(`/fiscal-providers/branch/${form.branchId}`)
      .then(rows => setFiscalProviders(rows.filter(r => r.hasCredentials)))
      .catch(() => setFiscalProviders([]));
  }, [modal, form.branchId]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '',
      branchId: branches[0]?.id ?? '',
      currencyId: currencies[0]?.id ?? '',
      isFiscal: false,
      fiscalProvider: '',
      providerCashRegisterId: '',
      initialBalance: '0',
    });
    setError('');
    setModal(true);
  };

  const openEdit = (r: CashRegister) => {
    setEditing(r);
    setForm({
      name: r.name,
      branchId: r.branchId,
      currencyId: r.currencyId,
      isFiscal: r.isFiscal,
      fiscalProvider: r.fiscalProvider ?? '',
      providerCashRegisterId: r.providerCashRegisterId ?? '',
      initialBalance: String(r.initialBalance),
    });
    setError('');
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError(t('registers.nameRequired'));
      return;
    }
    if (!form.currencyId) {
      setError(t('registers.currencyRequired'));
      return;
    }
    // Прив'язку до ПРРО шлемо лише для фіскальної каси; для звичайної — очищаємо (порожній рядок).
    const provider = form.isFiscal ? form.fiscalProvider : '';
    const providerReg = form.isFiscal ? form.providerCashRegisterId.trim() : '';
    try {
      if (editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          name: form.name.trim(),
          currencyId: form.currencyId,
          isFiscal: form.isFiscal,
          fiscalProvider: provider,
          providerCashRegisterId: providerReg,
          initialBalance: Number(form.initialBalance) || 0,
        });
      } else {
        await createMut.mutateAsync({
          name: form.name.trim(),
          branchId: form.branchId,
          currencyId: form.currencyId,
          isFiscal: form.isFiscal,
          fiscalProvider: provider,
          providerCashRegisterId: providerReg,
          initialBalance: Number(form.initialBalance) || 0,
        });
      }
      setModal(false);
      toast.success(t('common.saved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('registers.saveError'));
    }
  };

  const remove = async (r: CashRegister) => {
    if (
      !(await confirm({
        title: t('registers.deleteConfirmTitle'),
        message: t('registers.deleteConfirmMessage', { name: r.name }),
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(r.id);
      toast.success(t('registers.deleted'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('registers.deleteError'));
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">{t('registers.description')}</p>
        {canManage && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            {t('registers.addButton')}
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('registers.colName')}</TableHead>
              <TableHead>{t('registers.colBranch')}</TableHead>
              <TableHead>{t('registers.colType')}</TableHead>
              <TableHead className="text-right">{t('registers.colBalance')}</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (registers?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4} className="p-0">
                  <EmptyState
                    icon={Landmark}
                    title={t('registers.empty')}
                    description={t('registers.emptyDescription')}
                  />
                </TableCell>
              </TableRow>
            )}
            {registers?.map(r => (
              <TableRow key={r.id} className="group">
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-[13px] text-muted-foreground">{r.branchName}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {r.isFiscal ? (
                      <Badge variant="warning">{t('registers.typeFiscal')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('registers.typeRegular')}</Badge>
                    )}
                    {r.isFiscal && r.fiscalProvider && (
                      <Badge variant="secondary" title={t('registers.prroBadgeTitle')}>
                        {t('registers.prroBadge', {
                          provider: fiscalProviderLabel(r.fiscalProvider),
                        })}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {fmtMoney(r.balance)} {r.currencySymbol ?? r.currencyCode}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(r)}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove(r)}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        title={t('registers.deleteAria')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? t('registers.modalTitleEdit') : t('registers.modalTitleCreate')}
        footer={
          <Button
            onClick={save}
            loading={createMut.isPending || updateMut.isPending}
            disabled={!form.name.trim()}
            className="w-full"
          >
            {t('common.save')}
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label={t('registers.fieldName')}
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('registers.fieldNamePlaceholder')}
            autoFocus
            className="h-8 text-[13px]"
          />
          {!editing && (
            <Select
              label={t('registers.fieldBranch')}
              value={form.branchId}
              onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
            >
              {branches.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          {/* Валюта — і при створенні, і при редагуванні: каса без валюти не може вести
              операції з готівкою (currencyId NOT NULL на бекенді). Дозволяємо виправити
              валюту наявної каси, у якої вона не задана/некоректна. */}
          <Select
            label={t('registers.fieldCurrency')}
            required
            value={form.currencyId}
            onChange={e => setForm(f => ({ ...f, currencyId: e.target.value }))}
          >
            <option value="">{t('registers.currencyPlaceholder')}</option>
            {currencies.map(c => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </Select>
          <Input
            label={t('registers.fieldInitialBalance')}
            type="number"
            value={form.initialBalance}
            onChange={e => setForm(f => ({ ...f, initialBalance: e.target.value }))}
            className="h-8 text-[13px]"
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.isFiscal}
              onChange={e => setForm(f => ({ ...f, isFiscal: e.target.checked }))}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm text-foreground">{t('registers.fiscalCheckbox')}</span>
          </label>
          {form.isFiscal && (
            <div className="space-y-4 border-l-2 border-border pl-3">
              <div>
                <Select
                  label={t('registers.fieldProvider')}
                  value={form.fiscalProvider}
                  onChange={e => setForm(f => ({ ...f, fiscalProvider: e.target.value }))}
                >
                  <option value="">{t('registers.providerDefault')}</option>
                  {fiscalProviders.map(p => (
                    <option key={p.provider} value={p.provider}>
                      {fiscalProviderLabel(p.provider)}
                    </option>
                  ))}
                </Select>
                {fiscalProviders.length === 0 && (
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {t('registers.noProviders')}
                  </p>
                )}
              </div>
              <Input
                label={t('registers.fieldProviderRegId')}
                value={form.providerCashRegisterId}
                onChange={e => setForm(f => ({ ...f, providerCashRegisterId: e.target.value }))}
                placeholder={t('registers.providerRegIdPlaceholder')}
                className="h-8 text-[13px]"
              />
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
