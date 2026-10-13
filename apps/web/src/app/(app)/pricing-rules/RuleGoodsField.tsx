'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Trash2, Upload, X } from 'lucide-react';
import { PRICING_RULE_MAX_GOODS } from '@sto/shared';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { downloadBlob } from '@/lib/download';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GoodPickerModal, type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import { useConfirm } from '@/hooks/useConfirm';
import RuleGoodsImportPanel, { type ImportMode } from './RuleGoodsImportPanel';
import type { ResolveGoodsFileResult, RuleGood } from './types';

/** Список до 5000 рядків: одразу малюємо лише перші N відфільтрованих. */
const RENDER_LIMIT = 100;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Notice = { kind: 'success' | 'error'; text: string };

export type RuleGoodsLoad =
  { status: 'ready' } | { status: 'loading' } | { status: 'error'; message: string | null };

/**
 * Поле «Товари правила»: локальний список форми (до `PRICING_RULE_MAX_GOODS`), який
 * поповнюється вручну через `GoodPickerModal` або з файла Excel/CSV. Нічого не зберігає сам —
 * список іде на сервер разом із правилом.
 */
export default function RuleGoodsField({
  goods,
  onChange,
  load,
  onRetry,
  onOverlayOpenChange,
}: {
  goods: RuleGood[];
  onChange: (next: RuleGood[]) => void;
  /** Стан довантаження повного списку при редагуванні; для нового правила — `ready`. */
  load: RuleGoodsLoad;
  onRetry: () => void;
  /** Повідомляє формі, що над нею відкрито модалку вибору товару або підтвердження. */
  onOverlayOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation('pricingRules');
  const { confirm, dialogProps } = useConfirm();
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [importResult, setImportResult] = useState<ResolveGoodsFileResult | null>(null);
  // Лічильник завантажень: `key` панелі, щоб кожен новий файл починав із «Додати до списку».
  const [importSeq, setImportSeq] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const overlayOpen = pickerOpen || dialogProps.open;
  const overlayCbRef = useRef(onOverlayOpenChange);
  overlayCbRef.current = onOverlayOpenChange;
  useEffect(() => {
    overlayCbRef.current?.(overlayOpen);
    return () => overlayCbRef.current?.(false);
  }, [overlayOpen]);

  const ready = load.status === 'ready';
  const selectedIds = useMemo(() => goods.map(g => g.id), [goods]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return goods;
    return goods.filter(
      g =>
        g.name.toLowerCase().includes(q) ||
        (g.sku ?? '').toLowerCase().includes(q) ||
        (g.internalCode ?? '').toLowerCase().includes(q),
    );
  }, [goods, search]);
  const visible = filtered.slice(0, RENDER_LIMIT);

  // Обробники вікна вибору читають список звідси, а не із замикання рендера: два виклики
  // до наступного рендера (програмні кліки, відповідь сканера, що прийшла зі старим
  // обробником) інакше будували б новий список від одного й того самого старого — і другий
  // затирав би перший.
  const goodsRef = useRef(goods);
  goodsRef.current = goods;
  const commit = (next: RuleGood[]) => {
    goodsRef.current = next;
    onChange(next);
  };

  const limitMessage = () => t('goods.limitReached', { max: PRICING_RULE_MAX_GOODS });

  const openPicker = () => {
    if (goods.length >= PRICING_RULE_MAX_GOODS) {
      setNotice({ kind: 'error', text: limitMessage() });
      return;
    }
    setNotice(null);
    setPickerOpen(true);
  };

  const addGood = (item: GoodPickerItem) => {
    const goods = goodsRef.current;
    if (goods.some(g => g.id === item.id)) return;
    if (goods.length >= PRICING_RULE_MAX_GOODS) {
      // Модалка вибору перекриває форму — тому ще й toast, не лише рядок під списком.
      setNotice({ kind: 'error', text: limitMessage() });
      toast.error(limitMessage());
      return;
    }
    commit([...goods, toRuleGood(item)]);
  };

  const toRuleGood = (item: GoodPickerItem): RuleGood => ({
    id: item.id,
    internalCode: item.internalCode ?? null,
    name: item.name,
    sku: item.sku ?? null,
    brandName: item.brandName ?? null,
  });

  // «Відмітити всі» у вікні вибору: додаємо, скільки вміщує список, решту — пояснюємо.
  const addGoods = (items: GoodPickerItem[]) => {
    const goods = goodsRef.current;
    const have = new Set(goods.map(g => g.id));
    const fresh = items.filter(i => !have.has(i.id));
    const room = PRICING_RULE_MAX_GOODS - goods.length;
    if (fresh.length > room) {
      setNotice({ kind: 'error', text: limitMessage() });
      toast.error(limitMessage());
    }
    const accepted = fresh.slice(0, Math.max(room, 0));
    if (accepted.length > 0) commit([...goods, ...accepted.map(toRuleGood)]);
  };

  const removeGoods = (ids: string[]) => {
    const goods = goodsRef.current;
    const drop = new Set(ids);
    if (goods.some(g => drop.has(g.id))) commit(goods.filter(g => !drop.has(g.id)));
  };

  const clearAll = async () => {
    if (goods.length === 0) return;
    const ok = await confirm({
      title: t('goods.clearConfirmTitle'),
      message: t('goods.clearConfirmMessage', { n: goods.length }),
      confirmLabel: t('goods.clearConfirmLabel'),
      variant: 'destructive',
    });
    if (!ok) return;
    onChange([]);
    setSearch('');
    setNotice(null);
  };

  const downloadTemplate = async () => {
    setTemplateLoading(true);
    try {
      const data = await apiFetch<{ file: string; filename: string }>(
        '/xlsx/templates/pricing-rule-goods',
      );
      const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0));
      const isCsv = data.filename.toLowerCase().endsWith('.csv');
      downloadBlob(
        new Blob([bytes], { type: isCsv ? 'text/csv; charset=utf-8' : XLSX_MIME }),
        data.filename,
      );
    } catch (e: unknown) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : t('goods.templateError') });
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Скидаємо input, щоб той самий файл можна було вибрати ще раз.
    e.target.value = '';
    setResolving(true);
    setNotice(null);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await apiMultipartFetch<ResolveGoodsFileResult>(
        '/xlsx/pricing-rule-goods/resolve',
        fd,
      );
      setImportResult(result);
      setImportSeq(s => s + 1);
    } catch (err: unknown) {
      // Текст 400 («файл порожній», «рядків більше 5000») приходить із сервера українською.
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : t('goodsImport.error'),
      });
    } finally {
      setResolving(false);
    }
  };

  const applyImport = (next: RuleGood[], mode: ImportMode, affected: number) => {
    onChange(next);
    setImportResult(null);
    setNotice({
      kind: 'success',
      text: t(mode === 'add' ? 'goods.added' : 'goods.replaced', { n: affected }),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[13px] font-medium text-foreground tabular-nums">
          {t('goods.title', { n: goods.length })}
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={openPicker}
            disabled={!ready}
          >
            {t('goods.add')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Upload className="h-3.5 w-3.5" />}
            onClick={() => fileRef.current?.click()}
            loading={resolving}
            disabled={!ready}
          >
            {t('goods.upload')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            onClick={() => void downloadTemplate()}
            loading={templateLoading}
          >
            {t('goods.template')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => void clearAll()}
            disabled={!ready || goods.length === 0}
          >
            {t('goods.clear')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            aria-label={t('goods.fileLabel')}
            accept={`.xlsx,.csv,${XLSX_MIME},text/csv`}
            onChange={e => void handleFile(e)}
            className="hidden"
          />
        </div>
      </div>

      {notice && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'text-[12px] rounded px-2 py-1 border tabular-nums',
            notice.kind === 'error'
              ? 'text-destructive-text bg-destructive-subtle border-destructive-border'
              : 'text-foreground bg-secondary border-border',
          )}
        >
          {notice.text}
        </p>
      )}

      {importResult && (
        <RuleGoodsImportPanel
          key={importSeq}
          result={importResult}
          current={goods}
          maxGoods={PRICING_RULE_MAX_GOODS}
          onApply={applyImport}
          onCancel={() => setImportResult(null)}
        />
      )}

      {load.status === 'loading' && (
        <div
          role="status"
          className="flex items-center gap-2 py-3 text-[13px] text-muted-foreground"
        >
          <Spinner size="sm" />
          {t('goods.loading')}
        </div>
      )}

      {load.status === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
        >
          <span>{load.message ?? t('goods.loadError')}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('goods.retry')}
          </Button>
        </div>
      )}

      {ready && goods.length === 0 && (
        <p className="text-[12px] text-muted-foreground py-2">{t('goods.empty')}</p>
      )}

      {ready && goods.length > 0 && (
        <>
          <Input
            aria-label={t('goods.searchLabel')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('goods.searchPlaceholder')}
            className="h-8 text-[13px]"
          />
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <caption className="sr-only">{t('goods.tableCaption')}</caption>
              <thead className="bg-secondary border-b border-border sticky top-0">
                <tr>
                  <th
                    scope="col"
                    className="text-left px-3 py-1.5 text-muted-foreground font-medium"
                  >
                    {t('goods.columns.name')}
                  </th>
                  <th
                    scope="col"
                    className="text-left px-3 py-1.5 text-muted-foreground font-medium"
                  >
                    {t('goods.columns.sku')}
                  </th>
                  <th
                    scope="col"
                    className="text-left px-3 py-1.5 text-muted-foreground font-medium"
                  >
                    {t('goods.columns.brand')}
                  </th>
                  <th scope="col" className="w-10 px-2 py-1.5">
                    <span className="sr-only">{t('goods.columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map(g => (
                  <tr key={g.id} className="bg-surface">
                    <td className="px-3 py-1.5 text-foreground">{g.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{g.sku ?? '—'}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{g.brandName ?? '—'}</td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => onChange(goods.filter(x => x.id !== g.id))}
                        aria-label={t('goods.remove', { name: g.name })}
                        title={t('goods.remove', { name: g.name })}
                        className="text-destructive/70 hover:text-destructive p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 text-center text-muted-foreground">
                      {t('goods.nothingFound')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > RENDER_LIMIT && (
            <p className="text-[12px] text-muted-foreground tabular-nums">
              {t('goods.shownOf', { shown: RENDER_LIMIT, total: filtered.length })}
            </p>
          )}
        </>
      )}

      <GoodPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addGood}
        multiple
        selectedIds={selectedIds}
        onDeselect={id => removeGoods([id])}
        onSelectMany={addGoods}
        onDeselectMany={removeGoods}
        doneLabel={t('goods.pickerDone')}
        addedLabel={t('goods.pickerAdded')}
        selectAllLabel={t('goods.pickerSelectAll')}
        deselectAllLabel={t('goods.pickerDeselectAll')}
        countLabel={(added, shown) => t('goods.pickerCount', { added, shown })}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
