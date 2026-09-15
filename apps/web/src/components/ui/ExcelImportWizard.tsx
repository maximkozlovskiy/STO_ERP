'use client';

// Generic майстер Excel-імпорту товарів у документ (замовлення постачальнику / складський
// документ). Двокроковий: (1) налаштування колонок + файл, (2) резолвінг знайдених рядків.
// Стиль модалки — як RulePricerModal (суб-діалог поверх основної модалки документа).
import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react';
import { Upload, Check } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  useRawPreview,
  usePreviewImport,
  useApplyImport,
  useCounterpartyImportMapping,
  useUpsertImportMapping,
  type ExcelImportDocType,
  type ImportMapping,
  type PreviewRow,
  type ApplyRow,
  type RawPreviewResponse,
} from '@/hooks/api/useExcelImport';

export interface ExcelImportWizardProps {
  open: boolean;
  onClose: () => void;
  docType: ExcelImportDocType;
  docId: string;
  /** Людиночитний номер документа (напр. «ЗАМ-2026-000780») — показується у шапці. */
  docNumber?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  onImportComplete: () => void;
}

// Локальний стан рядка на кроці 2.
interface RowResolution {
  selectedGoodId: string; // для matched/ambiguous
  included: boolean; // чи включати рядок в імпорт (для notFound = «створити нову позицію»)
}

// Чи готовий рядок реально піти в apply (не лише позначений). Єдине джерело правди
// для лічильника «готово» і збірки resolved у handleApply — щоб «Обрано» не вводило в оману
// (наприклад ambiguous без обраного товару або notFound без назви позначені, але не імпортуються).
function isRowApplyable(row: PreviewRow, res: RowResolution | undefined): boolean {
  if (!res || !res.included) return false;
  if (row.status === 'matched' || row.status === 'ambiguous') {
    return !!res.selectedGoodId;
  }
  // notFound → потрібна назва (з rawName або rawArticle)
  return !!(row.rawName || row.rawArticle || '').trim();
}

const DEFAULT_MAPPING: ImportMapping = {
  startRow: 2,
  codeCol: null,
  articleCol: null,
  brandCol: null,
  nameCol: null,
  quantityCol: null,
  priceCol: null,
};

// Числове поле мапінгу → рядок для інпута (null/0 → порожній рядок).
function numToStr(v: number | null): string {
  return v != null && v > 0 ? String(v) : '';
}
// Рядок інпута → число мапінгу (порожній → null).
function strToNum(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const numFmt = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// 1-based номер колонки → літера Excel (1→A, 2→B, 27→AA).
function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Підписи ролей колонок для підсвітки передперегляду (1-based номер → назва ролі).
const COL_ROLE_LABELS: [keyof ImportMapping, string][] = [
  ['codeCol', 'Код'],
  ['articleCol', 'Артикул'],
  ['brandCol', 'Бренд'],
  ['nameCol', 'Назва'],
  ['quantityCol', 'К-сть'],
  ['priceCol', 'Ціна'],
];

export function ExcelImportWizard({
  open,
  onClose,
  docType,
  docId,
  docNumber,
  counterpartyId,
  counterpartyName,
  onImportComplete,
}: ExcelImportWizardProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [rawPreview, setRawPreview] = useState<RawPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>(DEFAULT_MAPPING);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [resolutions, setResolutions] = useState<Record<number, RowResolution>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Збережений мапінг застосовуємо ЛИШЕ один раз за відкриття — інакше refetch react-query
  // (focus / staleTime) віддає новий референс і мовчки затирає введені користувачем колонки.
  const mappingAppliedRef = useRef(false);

  const rawPreviewMut = useRawPreview();
  const previewMut = usePreviewImport();
  const applyMut = useApplyImport();
  const upsertMapping = useUpsertImportMapping();
  const { data: savedMapping } = useCounterpartyImportMapping(open ? counterpartyId : undefined);

  // При відкритті — скидаємо на крок 1 і підтягуємо збережений мапінг контрагента (якщо є).
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setFile(null);
    setRawPreview(null);
    setRows([]);
    setResolutions({});
    setMapping(DEFAULT_MAPPING);
    mappingAppliedRef.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open]);

  // savedMapping приходить асинхронно — застосовуємо ОДИН раз за відкриття (коли з'явився).
  useEffect(() => {
    if (open && savedMapping && step === 1 && !mappingAppliedRef.current) {
      mappingAppliedRef.current = true;
      setMapping({
        startRow: savedMapping.startRow || 2,
        codeCol: savedMapping.codeCol,
        articleCol: savedMapping.articleCol,
        brandCol: savedMapping.brandCol,
        nameCol: savedMapping.nameCol,
        quantityCol: savedMapping.quantityCol,
        priceCol: savedMapping.priceCol,
      });
    }
  }, [open, savedMapping, step]);

  const setCol = useCallback((key: keyof ImportMapping, value: string) => {
    setMapping(m => ({ ...m, [key]: strToNum(value) }));
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setRawPreview(null);
    if (!f) return;
    // Сирий передперегляд одразу після вибору файлу — щоб користувач бачив вміст і колонки.
    rawPreviewMut.mutate(f, {
      onSuccess: data => setRawPreview(data),
      onError: () => {
        // Тиха деградація: без передперегляду майстер усе одно робочий (colnums вводяться вручну).
        setRawPreview(null);
      },
    });
  };

  // Крок 1 → 2: preview + fire-and-forget збереження мапінгу контрагента.
  const handlePreview = useCallback(async () => {
    // Bug #630 клас: синхронний guard проти подвійного сабміту — disabled від isPending
    // оновлюється асинхронно, два кліки в одному тіку інакше обидва пройдуть.
    if (previewMut.isPending) return;
    if (!file) {
      toast.error('Оберіть файл Excel');
      return;
    }
    if (!mapping.startRow || mapping.startRow < 1) {
      toast.error('Вкажіть номер першого рядка (≥ 1)');
      return;
    }
    try {
      const res = await previewMut.mutateAsync({ file, docType, docId, mapping });
      // Зберегти мапінг для контрагента — fire-and-forget, не блокує перехід.
      if (counterpartyId) {
        upsertMapping.mutate({ counterpartyId, mapping }, { onError: () => {} });
      }
      const initial: Record<number, RowResolution> = {};
      for (const row of res.rows) {
        initial[row.rowIndex] = {
          selectedGoodId:
            row.status === 'matched'
              ? (row.matchedGoodId ?? '')
              : row.status === 'ambiguous'
                ? (row.candidates[0]?.id ?? '')
                : '',
          // matched/ambiguous — включаємо одразу (товар знайдено); notFound — ні (треба рішення).
          included: row.status !== 'notFound',
        };
      }
      setRows(res.rows);
      setResolutions(initial);
      setStep(2);
      if (res.rows.length === 0) {
        toast.warning('У файлі не знайдено рядків для імпорту');
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка розпізнавання файлу');
    }
  }, [file, mapping, docType, docId, counterpartyId, previewMut, upsertMapping]);

  const setRowGood = useCallback((rowIndex: number, goodId: string) => {
    setResolutions(r => ({ ...r, [rowIndex]: { ...r[rowIndex], selectedGoodId: goodId } }));
  }, []);
  const setRowIncluded = useCallback((rowIndex: number, included: boolean) => {
    setResolutions(r => ({ ...r, [rowIndex]: { ...r[rowIndex], included } }));
  }, []);

  // Масові дії над вибором рядків (крок 2).
  const setAllIncluded = useCallback(
    (value: boolean) => {
      setResolutions(prev => {
        const next = { ...prev };
        for (const row of rows) {
          next[row.rowIndex] = { ...next[row.rowIndex], included: value };
        }
        return next;
      });
    },
    [rows],
  );
  const invertIncluded = useCallback(() => {
    setResolutions(prev => {
      const next = { ...prev };
      for (const row of rows) {
        const cur = next[row.rowIndex];
        next[row.rowIndex] = { ...cur, included: !cur?.included };
      }
      return next;
    });
  }, [rows]);

  // Крок 2 → apply: збираємо резолвлені рядки.
  const handleApply = useCallback(async () => {
    // Bug #630 клас: синхронний guard проти подвійного сабміту (див. handlePreview).
    if (applyMut.isPending) return;
    const resolved: ApplyRow[] = [];
    for (const row of rows) {
      const res = resolutions[row.rowIndex];
      if (!res || !isRowApplyable(row, res)) continue; // не позначено / не готово → пропустити
      if (row.status === 'matched' || row.status === 'ambiguous') {
        resolved.push({
          rowIndex: row.rowIndex,
          action: 'use',
          goodId: res.selectedGoodId,
          quantity: row.quantity,
          price: row.price,
        });
      } else {
        // notFound + included → створюємо нову позицію
        const name = (row.rawName || row.rawArticle || '').trim();
        if (!name) continue; // немає з чого створити позицію
        resolved.push({
          rowIndex: row.rowIndex,
          action: 'create',
          createData: {
            name,
            sku: row.rawArticle?.trim() || undefined,
            rawBrand: row.rawBrand?.trim() || undefined,
          },
          quantity: row.quantity,
          price: row.price,
        });
      }
    }

    if (resolved.length === 0) {
      toast.error('Немає рядків для імпорту — позначте рядки та оберіть товари');
      return;
    }

    try {
      await applyMut.mutateAsync({ docType, docId, rows: resolved });
      toast.success(`Додано позицій: ${resolved.length}`);
      onImportComplete();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка додавання товарів');
    }
  }, [rows, resolutions, docType, docId, applyMut, onImportComplete, onClose]);

  const statusRowClass = (status: PreviewRow['status']): string => {
    if (status === 'matched') return 'bg-success-subtle';
    if (status === 'ambiguous') return 'bg-warning-subtle';
    return 'bg-destructive-subtle';
  };

  // 1-based номер колонки → підпис ролі (для підсвітки шапки передперегляду).
  const roleByCol = new Map<number, string>();
  for (const [key, label] of COL_ROLE_LABELS) {
    const col = mapping[key];
    if (typeof col === 'number' && col > 0) roleByCol.set(col, label);
  }

  const matchedCount = rows.filter(r => r.status === 'matched').length;
  const ambiguousCount = rows.filter(r => r.status === 'ambiguous').length;
  const notFoundCount = rows.filter(r => r.status === 'notFound').length;
  const includedCount = rows.filter(r => resolutions[r.rowIndex]?.included).length;
  // Скільки з позначених рядків реально піде в імпорт (ambiguous без товару / notFound без назви
  // позначені, але не імпортуються) — щоб «Обрано» не вводило в оману.
  const readyCount = rows.filter(r => isRowApplyable(r, resolutions[r.rowIndex])).length;
  const allIncluded = rows.length > 0 && includedCount === rows.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        docNumber ? `Завантаження товарів з Excel · ${docNumber}` : 'Завантаження товарів з Excel'
      }
      size={step === 2 || rawPreview ? 'xl' : 'md'}
    >
      {step === 1 ? (
        <div className="flex flex-col gap-4" style={{ minHeight: '200px' }}>
          {/* Контрагент (readonly) */}
          <div>
            <label className="text-[13px] font-medium text-foreground leading-none">
              Контрагент
            </label>
            <div className="mt-1 h-9 flex items-center px-3 rounded border border-border bg-secondary text-[14px] text-muted-foreground">
              {counterpartyName || '—'}
            </div>
          </div>

          {/* Файл */}
          <div>
            <label className="text-[13px] font-medium text-foreground leading-none">
              Файл Excel <span className="text-destructive">*</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileChange}
              className="mt-1 block w-full text-[13px] text-foreground file:mr-3 file:rounded file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-foreground hover:file:bg-secondary"
            />
          </div>

          {/* Мапінг колонок */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Перший рядок даних"
              type="number"
              min={1}
              value={numToStr(mapping.startRow)}
              onChange={e => setMapping(m => ({ ...m, startRow: strToNum(e.target.value) ?? 1 }))}
            />
            <Input
              label="Колонка коду"
              type="number"
              min={1}
              value={numToStr(mapping.codeCol)}
              onChange={e => setCol('codeCol', e.target.value)}
            />
            <Input
              label="Колонка артикулу"
              type="number"
              min={1}
              value={numToStr(mapping.articleCol)}
              onChange={e => setCol('articleCol', e.target.value)}
            />
            <Input
              label="Колонка бренду"
              type="number"
              min={1}
              value={numToStr(mapping.brandCol)}
              onChange={e => setCol('brandCol', e.target.value)}
            />
            <Input
              label="Колонка найменування"
              type="number"
              min={1}
              value={numToStr(mapping.nameCol)}
              onChange={e => setCol('nameCol', e.target.value)}
            />
            <Input
              label="Колонка кількості"
              type="number"
              min={1}
              value={numToStr(mapping.quantityCol)}
              onChange={e => setCol('quantityCol', e.target.value)}
            />
            <Input
              label="Колонка ціни"
              type="number"
              min={1}
              value={numToStr(mapping.priceCol)}
              onChange={e => setCol('priceCol', e.target.value)}
            />
          </div>

          {/* Передперегляд файлу — сирі рядки з підсвіткою обраних колонок */}
          {rawPreviewMut.isPending ? (
            <div className="text-[12px] text-muted-foreground py-2">Читаємо файл…</div>
          ) : rawPreview && rawPreview.rows.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-foreground leading-none">
                  Передперегляд файлу
                </label>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  показано {rawPreview.rows.length} з {rawPreview.totalRows}{' '}
                  {rawPreview.totalRows === 1 ? 'рядка' : 'рядків'}
                </span>
              </div>
              <div
                className="rounded-lg border border-border overflow-auto"
                style={{ maxHeight: '32vh' }}
              >
                <table className="text-[12px] border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-secondary">
                      <th className="px-2 py-1.5 text-[10px] font-semibold text-foreground-muted border-b border-r border-border text-right sticky left-0 bg-secondary">
                        #
                      </th>
                      {Array.from({ length: rawPreview.columnCount }, (_, i) => {
                        const col = i + 1;
                        const role = roleByCol.get(col);
                        return (
                          <th
                            key={col}
                            className={cn(
                              'px-2 py-1.5 text-[10px] font-semibold border-b border-border whitespace-nowrap text-left',
                              role ? 'bg-info-subtle text-info-text' : 'text-foreground-muted',
                            )}
                            title={role ? `Колонка ${colLetter(col)} → ${role}` : undefined}
                          >
                            {colLetter(col)}
                            {role ? ` · ${role}` : ''}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rawPreview.rows.map((cells, ri) => (
                      <tr key={ri} className="border-b border-border/60">
                        <td className="px-2 py-1 text-[10px] text-muted-foreground border-r border-border text-right tabular-nums sticky left-0 bg-surface">
                          {ri + 1}
                        </td>
                        {Array.from({ length: rawPreview.columnCount }, (_, i) => {
                          const col = i + 1;
                          const highlighted = roleByCol.has(col);
                          return (
                            <td
                              key={col}
                              className={cn(
                                'px-2 py-1 whitespace-nowrap max-w-55 overflow-hidden text-ellipsis',
                                highlighted ? 'bg-info-subtle text-foreground' : 'text-foreground',
                              )}
                              title={cells[i] || undefined}
                            >
                              {cells[i] || ''}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose} disabled={previewMut.isPending}>
              Скасувати
            </Button>
            <Button
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => void handlePreview()}
              loading={previewMut.isPending}
              disabled={previewMut.isPending || !file}
            >
              Ідентифікувати товари
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" style={{ minHeight: '200px' }}>
          {/* Легенда результату */}
          <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm bg-success-subtle border border-success-border" />
              Знайдено: {matchedCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm bg-warning-subtle border border-warning-border" />
              Уточнити: {ambiguousCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm bg-destructive-subtle border border-destructive-border" />
              Не знайдено: {notFoundCount}
            </span>
          </div>

          {/* Масові дії над вибором рядків */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAllIncluded(true)}
              disabled={rows.length === 0}
            >
              Вибрати всі
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAllIncluded(false)}
              disabled={rows.length === 0}
            >
              Забрати всі
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={invertIncluded}
              disabled={rows.length === 0}
            >
              Інвертувати вибір
            </Button>
            <span className="text-[12px] text-muted-foreground tabular-nums ml-auto">
              Обрано: {includedCount} / {rows.length}
              {readyCount !== includedCount ? ` · до імпорту: ${readyCount}` : ''}
            </span>
          </div>

          <div
            className="rounded-lg border border-border overflow-auto"
            style={{ maxHeight: '55vh' }}
          >
            <table className="w-full text-[12px]">
              <colgroup>
                <col className="w-11" />
                <col className="w-[15%]" />
                <col className="w-[11%]" />
                <col />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[28%]" />
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-border bg-secondary">
                  <th className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={allIncluded}
                      onChange={e => setAllIncluded(e.target.checked)}
                      disabled={rows.length === 0}
                      aria-label="Вибрати всі рядки"
                      className="h-3.5 w-3.5 rounded border-border align-middle"
                    />
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    Артикул
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    Бренд
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    Найменування
                  </th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    К-сть
                  </th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    Ціна
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted">
                    Статус / дія
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      Немає рядків для імпорту
                    </td>
                  </tr>
                ) : (
                  rows.map(row => {
                    const res = resolutions[row.rowIndex];
                    return (
                      <tr
                        key={row.rowIndex}
                        className={cn(
                          'border-b border-border/60',
                          statusRowClass(row.status),
                          !res?.included && 'opacity-45',
                        )}
                      >
                        <td className="px-2 py-2 align-top text-center">
                          <input
                            type="checkbox"
                            checked={res?.included ?? false}
                            onChange={e => setRowIncluded(row.rowIndex, e.target.checked)}
                            aria-label={`Включити рядок ${row.rowIndex} в імпорт`}
                            className="h-3.5 w-3.5 rounded border-border align-middle"
                          />
                        </td>
                        <td className="px-3 py-2 align-top text-foreground">
                          {row.rawArticle || row.rawCode || '—'}
                        </td>
                        <td className="px-3 py-2 align-top text-foreground">
                          {row.rawBrand || '—'}
                        </td>
                        <td className="px-3 py-2 align-top text-foreground">
                          {row.rawName || '—'}
                        </td>
                        <td className="px-3 py-2 align-top text-right tabular-nums">
                          {numFmt.format(row.quantity)}
                        </td>
                        <td className="px-3 py-2 align-top text-right tabular-nums">
                          {numFmt.format(row.price)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {row.status === 'matched' ? (
                            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-success-text">
                              <Check className="h-3.5 w-3.5" />
                              {row.candidates.find(c => c.id === row.matchedGoodId)?.name ??
                                'Знайдено'}
                            </span>
                          ) : row.status === 'ambiguous' ? (
                            <Select
                              value={res?.selectedGoodId ?? ''}
                              onChange={e => setRowGood(row.rowIndex, e.target.value)}
                              className="h-8 text-[12px]"
                            >
                              <option value="">— оберіть товар —</option>
                              {row.candidates.map(c => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                  {c.sku ? ` (${c.sku})` : ''}
                                  {c.brandName ? ` · ${c.brandName}` : ''}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">
                              {res?.included
                                ? 'Буде створено нову позицію'
                                : 'Не знайдено — оберіть, щоб створити'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2 justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(1)} disabled={applyMut.isPending}>
              Назад
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={applyMut.isPending}>
                Скасувати
              </Button>
              <Button
                onClick={() => void handleApply()}
                loading={applyMut.isPending}
                disabled={applyMut.isPending || readyCount === 0}
              >
                Заповнити товарами
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
