'use client';

import { useMemo, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {
  X,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Play,
  Save,
  Download,
  Filter,
} from 'lucide-react';
import {
  useReportMetadata,
  useRunReport,
  useSavedReports,
  useSaveReport,
  useDeleteSavedReport,
  type MetaEntity,
  type MetaField,
  type ReportConfig,
  type ReportRunResult,
  type GroupNode,
  type Agg,
  type ReportFilter,
} from '@/hooks/api/useReportBuilder';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Modal } from '@/components/ui/modal';
import { fmtMoney, fmtDate, fmtInt } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  WO_STATUS_LABELS,
  WO_PRIORITY_LABELS,
  INVOICE_STATUS_LABELS,
  PO_STATUS_LABELS,
  COUNTERPARTY_TYPE_LABELS,
  GOOD_TYPE_LABELS,
  STOCK_MOVEMENT_TYPE_LABELS,
  SETTLEMENT_TX_TYPE_LABELS,
} from '@sto/shared';

type Zone = 'columns' | 'groupBy' | 'filters';

/** enumName реєстру → мапа перекладу (мовою інтерфейсу). Bug: статуси показувались англійською. */
const ENUM_LABELS: Record<string, Record<string, string>> = {
  WorkOrderStatus: WO_STATUS_LABELS,
  WorkOrderPriority: WO_PRIORITY_LABELS,
  InvoiceStatus: INVOICE_STATUS_LABELS,
  PurchaseOrderStatus: PO_STATUS_LABELS,
  CounterpartyType: COUNTERPARTY_TYPE_LABELS,
  GoodType: GOOD_TYPE_LABELS,
  StockMovementType: STOCK_MOVEMENT_TYPE_LABELS,
  SettlementTransactionType: SETTLEMENT_TX_TYPE_LABELS,
};

/** Переклад enum-значення (fallback — сире значення, якщо мапи/ключа немає). */
function enumLabel(enumName: string | undefined, value: unknown): string {
  const v = String(value ?? '');
  if (!enumName) return v;
  return ENUM_LABELS[enumName]?.[v] ?? v;
}

const AGG_LABELS: Record<Agg, string> = {
  SUM: 'Сума',
  COUNT: 'Кількість',
  AVG: 'Середнє',
  MIN: 'Мінімум',
  MAX: 'Максимум',
};

/** Короткі позначки агрегатів для заголовків колонок результату (щоб не було «Сума: Сума»). */
const AGG_SHORT: Record<Agg, string> = {
  SUM: 'Σ',
  COUNT: 'К-сть',
  AVG: 'сер.',
  MIN: 'мін.',
  MAX: 'макс.',
};

/** Колір чіпа за типом поля. */
function chipTone(type: string): string {
  switch (type) {
    case 'enum':
      return 'bg-success-subtle text-success';
    case 'decimal':
    case 'number':
      return 'bg-warning-subtle text-warning';
    case 'date':
      return 'bg-primary/10 text-primary';
    default:
      return 'bg-secondary text-foreground';
  }
}

function isRelation(key: string): boolean {
  return key.includes('.');
}

/** Кнопка-літера для додавання поля у зону (К/Г/Ф) на чіпі палітри. */
function ZoneBtn({
  letter,
  title,
  active,
  disabled,
  onClick,
}: {
  letter: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded text-[11px] font-semibold transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        disabled
          ? 'opacity-30 cursor-not-allowed'
          : active
            ? 'bg-primary text-white'
            : 'bg-surface/70 hover:bg-surface text-foreground',
      )}
    >
      {letter}
    </button>
  );
}

/** Рядок легенди кольорів: кольоровий кружечок + підпис типу поля. */
function ColorLegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block size-2.5 rounded-full', className)} />
      {label}
    </span>
  );
}

export function ReportBuilder() {
  const { data: meta, isLoading: metaLoading } = useReportMetadata();
  const runMut = useRunReport();
  const { data: saved } = useSavedReports();
  const saveMut = useSaveReport();
  const delMut = useDeleteSavedReport();

  const [entityKey, setEntityKey] = useState<string>('');
  const [columns, setColumns] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [filters, setFilters] = useState<ReportFilter[]>([]);
  const [aggs, setAggs] = useState<Record<string, Agg>>({}); // field.key → Agg
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortAgg, setSortAgg] = useState<{ alias: string; dir: 'asc' | 'desc' } | null>(null);
  const [result, setResult] = useState<ReportRunResult | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [configCollapsed, setConfigCollapsed] = useState(false);

  const entity: MetaEntity | undefined = useMemo(
    () => meta?.entities.find(e => e.key === entityKey),
    [meta, entityKey],
  );
  const fieldByKey = useMemo(() => {
    const m = new Map<string, MetaField>();
    entity?.fields.forEach(f => m.set(f.key, f));
    return m;
  }, [entity]);
  // field.key → enumName (для перекладу enum-значень у результаті/групуванні).
  const enumByField = useMemo(() => {
    const m: Record<string, string> = {};
    entity?.fields.forEach(f => {
      if (f.enumName) m[f.key] = f.enumName;
    });
    return m;
  }, [entity]);

  // Палітра ЗАВЖДИ показує всі поля сутності — одне поле може бути водночас колонкою,
  // групуванням І фільтром (різні виміри одного поля). Дубль у межах ОДНІЄЇ зони блокує
  // логіка drop (onDropToZone). Раніше поле зникало з палітри після додавання у будь-яку
  // зону → не можна було перетягнути ту саму «Суму» ще й у Фільтри.
  const paletteFields = entity?.fields ?? [];

  const resetSelection = (nextEntity: string) => {
    setEntityKey(nextEntity);
    setColumns([]);
    setGroupBy([]);
    setFilters([]);
    setAggs({});
    setSortAgg(null);
    setResult(null);
  };

  // ── Додавання поля у зону (через клік-кнопку АБО drop) ──
  const addToZone = (zone: Zone, key: string) => {
    const f = fieldByKey.get(key);
    if (!f) return;
    if (zone === 'groupBy') {
      // Порядок перевірок важливий: «вже додано» — раніше за ліміт,
      // інакше клік по вже-активному 6-му полі (при 5/5) кидає toast
      // «Максимум 5 рівнів», хоча поле в списку вже є (Bug #606).
      if (groupBy.includes(key)) return;
      if (!f.groupable) return toast.warning('Це поле не можна групувати');
      if (groupBy.length >= 5) return toast.warning('Максимум 5 рівнів групування');
      setGroupBy([...groupBy, key]);
    } else if (zone === 'columns') {
      if (!columns.includes(key)) setColumns([...columns, key]);
    } else {
      if (filters.some(x => x.field === key)) return;
      if (!f.filterable) return toast.warning('Це поле не фільтрується');
      setFilters([...filters, { field: key, op: 'eq' }]);
    }
  };

  // Drop (native HTML5) — резервний спосіб; основний тепер клік-кнопки на чіпі.
  const onDropToZone = (zone: Zone, ev: DragEvent) => {
    ev.preventDefault();
    const key = ev.dataTransfer.getData('text/field');
    if (key) addToZone(zone, key);
  };

  const removeFrom = (zone: Zone, key: string) => {
    if (zone === 'columns') {
      setColumns(columns.filter(k => k !== key));
      // Прибирання колонки → чистимо явну agg (щоб buildConfig не слав «висячу»)
      // та sortByAggregate, якщо саме за цим полем сортували (авто-SUM теж зникне).
      setAggs(prev => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (sortAgg && sortAgg.alias.endsWith(`_${key}`)) setSortAgg(null);
    } else if (zone === 'groupBy') setGroupBy(groupBy.filter(k => k !== key));
    else setFilters(filters.filter(f => f.field !== key));
  };

  /** Швидко додати поле у фільтри (кнопка «+ фільтр» на чіпі колонки/групування). */
  const addFilter = (key: string) => {
    const f = fieldByKey.get(key);
    if (!f?.filterable) return toast.warning('Це поле не фільтрується');
    if (filters.some(x => x.field === key)) return toast.info('Фільтр за цим полем уже є');
    setFilters([...filters, { field: key, op: 'eq' }]);
  };
  const isFiltered = (key: string) => filters.some(f => f.field === key);

  const buildConfig = (
    sortOverride?: { alias: string; dir: 'asc' | 'desc' } | null,
  ): ReportConfig => {
    const aggregations = Object.entries(aggs)
      .filter(([field]) => columns.includes(field))
      .map(([field, agg]) => ({ field, agg }));
    const s = sortOverride !== undefined ? sortOverride : sortAgg;
    return {
      entity: entityKey,
      columns,
      groupBy,
      filters: filters.length ? filters : undefined,
      aggregations: aggregations.length ? aggregations : undefined,
      dateRange: from && to ? { from, to } : undefined,
      includeRows: true, // детальні рядки завжди (діра #5)
      sortByAggregate: s ?? undefined,
    };
  };

  const run = async (sortOverride?: { alias: string; dir: 'asc' | 'desc' } | null) => {
    if (!entityKey) return toast.warning('Оберіть джерело даних');
    if (!columns.length && !groupBy.length) return toast.warning('Додайте хоча б одну колонку');
    try {
      setResult(await runMut.mutateAsync(buildConfig(sortOverride)));
      // Після ручного «Сформувати» — авто-згортати налаштування (звільнити місце під звіт).
      // Безпечно: згорнутий стан тепер показує компактну панель з вибором + кнопкою розгортання
      // (не ховає контроли повністю, як раніше — тоді групування ставало недосяжним).
      if (sortOverride === undefined) setConfigCollapsed(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка звіту');
    }
  };

  /** Клік по заголовку агрегату у результаті → сортувати групи за ним (toggle asc/desc). */
  const onSortByAgg = (alias: string) => {
    const next: { alias: string; dir: 'asc' | 'desc' } =
      sortAgg?.alias === alias
        ? { alias, dir: sortAgg.dir === 'desc' ? 'asc' : 'desc' }
        : { alias, dir: 'desc' };
    setSortAgg(next);
    void run(next);
  };

  const doSave = async () => {
    if (!saveName.trim()) return toast.warning('Вкажіть назву');
    try {
      await saveMut.mutateAsync({ name: saveName.trim(), config: buildConfig() });
      toast.success('Звіт збережено');
      setSaveOpen(false);
      setSaveName('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося зберегти');
    }
  };

  const loadSaved = (cfg: ReportConfig) => {
    setEntityKey(cfg.entity);
    setColumns(cfg.columns ?? []);
    setGroupBy(cfg.groupBy ?? []);
    setFilters(cfg.filters ?? []);
    const a: Record<string, Agg> = {};
    (cfg.aggregations ?? []).forEach(x => (a[x.field] = x.agg));
    setAggs(a);
    setFrom(cfg.dateRange?.from ?? '');
    setTo(cfg.dateRange?.to ?? '');
    setSortAgg(cfg.sortByAggregate ?? null);
    setResult(null);
  };

  if (metaLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4 py-4">
      {/* Ряд керування */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={entityKey}
          onChange={e => resetSelection(e.target.value)}
          className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px]"
        >
          <option value="">— Джерело даних —</option>
          {meta?.entities.map(e => (
            <option key={e.key} value={e.key}>
              {e.label}
            </option>
          ))}
        </select>
        {entity && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground">З</span>
              <DatePickerInput
                value={from}
                onChange={setFrom}
                placeholder="ДД.ММ.РРРР"
                className="w-32"
              />
              <span className="text-[13px] text-muted-foreground">По</span>
              <DatePickerInput
                value={to}
                onChange={setTo}
                placeholder="ДД.ММ.РРРР"
                className="w-32"
              />
            </div>
            <Button onClick={() => run()} disabled={runMut.isPending}>
              <Play className="size-4" /> Сформувати
            </Button>
            <Button variant="outline" onClick={() => setSaveOpen(true)}>
              <Save className="size-4" /> Зберегти
            </Button>
            {result && (
              <>
                <Button variant="outline" onClick={() => exportReport(result, 'csv')}>
                  <Download className="size-4" /> CSV
                </Button>
                <Button variant="outline" onClick={() => exportReport(result, 'xlsx')}>
                  <Download className="size-4" /> XLSX
                </Button>
              </>
            )}
            <Button
              variant="outline"
              onClick={() => setConfigCollapsed(c => !c)}
              aria-expanded={!configCollapsed}
              title={configCollapsed ? 'Показати налаштування звіту' : 'Згорнути налаштування'}
            >
              {configCollapsed ? (
                <>
                  <ChevronDown className="size-4" /> Налаштування
                </>
              ) : (
                <>
                  <ChevronUp className="size-4" /> Згорнути
                </>
              )}
            </Button>
          </>
        )}
      </div>

      {/* Збережені звіти */}
      {saved && saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Збережені:</span>
          {saved.map(s => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs"
            >
              <button
                type="button"
                className="hover:text-primary"
                onClick={() => loadSaved(s.config)}
              >
                {s.name}
              </button>
              <button
                type="button"
                aria-label="Видалити"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => delMut.mutate(s.id)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {!entity ? (
        <div className="text-muted-foreground text-sm py-10 text-center">
          Оберіть джерело даних, щоб почати конструювати звіт.
        </div>
      ) : null}

      {/* Компактна панель коли налаштування згорнуті — показує поточний вибір і дозволяє
          розгорнути назад. Без неї згорнутий стан ховав палітру → групування недосяжне. */}
      {entity && configCollapsed && (
        <button
          type="button"
          onClick={() => setConfigCollapsed(false)}
          aria-expanded={false}
          className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-surface px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          title="Розгорнути налаштування звіту"
        >
          <span className="flex items-center gap-1.5 font-medium text-primary">
            <ChevronDown className="size-4" /> Налаштування
          </span>
          <span className="text-muted-foreground">
            Групування:{' '}
            <span className="text-foreground">
              {groupBy.length ? groupBy.map(k => fieldByKey.get(k)?.label ?? k).join(' → ') : '—'}
            </span>
          </span>
          <span className="text-muted-foreground">
            Колонки:{' '}
            <span className="text-foreground">
              {columns.length ? columns.map(k => fieldByKey.get(k)?.label ?? k).join(', ') : '—'}
            </span>
          </span>
        </button>
      )}

      {entity && (
        <div
          className={cn(
            'grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4',
            configCollapsed && 'hidden',
          )}
        >
          {/* Палітра полів */}
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Поля «{entity.label}» — натисніть <b className="text-foreground">К</b> (колонка),{' '}
              <b className="text-foreground">Г</b> (групування) або{' '}
              <b className="text-foreground">Ф</b> (фільтр). Або перетягніть у зону.
            </div>
            <div className="flex flex-col gap-1">
              {paletteFields.map(f => (
                <div
                  key={f.key}
                  draggable
                  onDragStart={e => e.dataTransfer.setData('text/field', f.key)}
                  className={cn(
                    'flex items-center justify-between gap-1 rounded-lg px-2 py-1 text-xs',
                    chipTone(f.type),
                  )}
                  title={isRelation(f.key) ? `Зв'язане поле: ${f.key}` : f.key}
                >
                  <span className="cursor-grab select-none truncate">{f.label}</span>
                  <span className="flex items-center gap-0.5 shrink-0">
                    <ZoneBtn
                      letter="К"
                      title="Додати у колонки"
                      active={columns.includes(f.key)}
                      onClick={() => addToZone('columns', f.key)}
                    />
                    <ZoneBtn
                      letter="Г"
                      title={f.groupable ? 'Додати у групування' : 'Це поле не можна групувати'}
                      active={groupBy.includes(f.key)}
                      disabled={!f.groupable}
                      onClick={() => addToZone('groupBy', f.key)}
                    />
                    <ZoneBtn
                      letter="Ф"
                      title={f.filterable ? 'Додати у фільтри' : 'Це поле не фільтрується'}
                      active={filters.some(x => x.field === f.key)}
                      disabled={!f.filterable}
                      onClick={() => addToZone('filters', f.key)}
                    />
                  </span>
                </div>
              ))}
            </div>
            {/* Легенда кольорів чіпів */}
            <div className="mt-3 pt-2 border-t border-border flex flex-col gap-1 text-[11px] text-muted-foreground">
              <ColorLegendItem className="bg-warning-subtle text-warning" label="число / сума" />
              <ColorLegendItem className="bg-success-subtle text-success" label="список / статус" />
              <ColorLegendItem className="bg-primary/10 text-primary" label="дата" />
              <ColorLegendItem className="bg-secondary text-foreground" label="текст" />
            </div>
          </div>

          {/* Зони + результат */}
          <div className="flex flex-col gap-3 min-w-0">
            <DropZone
              title="Колонки"
              hint="що показувати"
              zone="columns"
              onDrop={onDropToZone}
              items={columns.map(k => ({ key: k, field: fieldByKey.get(k) }))}
              onRemove={removeFrom}
              onFilter={addFilter}
              isFiltered={isFiltered}
              renderExtra={f =>
                f && f.aggregations.length > 0 ? (
                  <select
                    value={aggs[f.key] ?? ''}
                    onChange={e =>
                      setAggs(prev => {
                        const next = { ...prev };
                        if (e.target.value) next[f.key] = e.target.value as Agg;
                        else delete next[f.key];
                        return next;
                      })
                    }
                    onClick={e => e.stopPropagation()}
                    className="ml-1 rounded border border-border bg-surface text-[11px] px-1 py-0.5"
                  >
                    <option value="">—</option>
                    {f.aggregations.map(a => (
                      <option key={a} value={a}>
                        {AGG_LABELS[a]}
                      </option>
                    ))}
                  </select>
                ) : null
              }
            />
            <DropZone
              title={`Групування (${groupBy.length}/5)`}
              hint="ієрархія рядків, до 5 рівнів"
              zone="groupBy"
              onDrop={onDropToZone}
              items={groupBy.map(k => ({ key: k, field: fieldByKey.get(k) }))}
              onRemove={removeFrom}
              onFilter={addFilter}
              isFiltered={isFiltered}
              ordered
            />
            <FilterZone
              filters={filters}
              fieldByKey={fieldByKey}
              enums={meta?.enums ?? {}}
              onDrop={onDropToZone}
              onRemove={k => removeFrom('filters', k)}
              onChange={setFilters}
            />
          </div>
        </div>
      )}

      {/* Результат — на всю ширину (щоб згорнуті налаштування давали більше місця) */}
      {entity && result && (
        <ResultView result={result} sort={sortAgg} onSort={onSortByAgg} enumByField={enumByField} />
      )}

      {/* Modal керує own mount/unmount + exit-анімацією; НЕ обгортати у {open && …} — це ламає exit. */}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Зберегти звіт">
        <div className="flex flex-col gap-3 p-1">
          <input
            autoFocus
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            placeholder="Назва звіту"
            className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px]"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Скасувати
            </Button>
            <Button onClick={doSave} disabled={saveMut.isPending}>
              Зберегти
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Drop-зона з чіпами ──────────────────────────────────────────────────────────
function DropZone({
  title,
  hint,
  zone,
  items,
  onDrop,
  onRemove,
  onFilter,
  isFiltered,
  renderExtra,
  ordered,
}: {
  title: string;
  hint: string;
  zone: Zone;
  items: { key: string; field: MetaField | undefined }[];
  onDrop: (zone: Zone, ev: DragEvent) => void;
  onRemove: (zone: Zone, key: string) => void;
  onFilter?: (key: string) => void;
  isFiltered?: (key: string) => boolean;
  renderExtra?: (f: MetaField | undefined) => ReactNode;
  ordered?: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={e => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false);
        onDrop(zone, e);
      }}
      className={cn(
        'rounded-xl border border-dashed p-3 transition-colors',
        over ? 'border-primary bg-primary/5' : 'border-border bg-surface',
      )}
    >
      <div className="text-xs font-medium text-foreground mb-2">
        {title} <span className="text-muted-foreground font-normal">· {hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 min-h-8">
        {items.length === 0 && (
          <span className="text-xs text-muted-foreground italic">Перетягніть поля сюди</span>
        )}
        {items.map((it, i) => (
          <span
            key={it.key}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
              chipTone(it.field?.type ?? 'scalar'),
            )}
          >
            {ordered && <span className="opacity-60 tabular-nums">{i + 1}.</span>}
            {it.field?.label ?? it.key}
            {renderExtra?.(it.field)}
            {onFilter && it.field?.filterable && (
              <button
                type="button"
                aria-label={isFiltered?.(it.key) ? 'Уже у фільтрах' : 'Додати у фільтри'}
                title={isFiltered?.(it.key) ? 'Уже у фільтрах' : 'Додати у фільтри'}
                className={cn(
                  'transition-colors',
                  isFiltered?.(it.key) ? 'text-primary' : 'opacity-60 hover:opacity-100',
                )}
                onClick={() => onFilter(it.key)}
              >
                <Filter className="size-3" />
              </button>
            )}
            <button
              type="button"
              aria-label="Прибрати"
              className="hover:text-destructive"
              onClick={() => onRemove(zone, it.key)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Зона фільтрів (з op + value) ─────────────────────────────────────────────────
function FilterZone({
  filters,
  fieldByKey,
  enums,
  onDrop,
  onRemove,
  onChange,
}: {
  filters: ReportFilter[];
  fieldByKey: Map<string, MetaField>;
  enums: Record<string, string[]>;
  onDrop: (zone: Zone, ev: DragEvent) => void;
  onRemove: (key: string) => void;
  onChange: (f: ReportFilter[]) => void;
}) {
  const [over, setOver] = useState(false);
  const update = (i: number, patch: Partial<ReportFilter>) => {
    onChange(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  };
  return (
    <div
      onDragOver={e => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false);
        onDrop('filters', e);
      }}
      className={cn(
        'rounded-xl border border-dashed p-3 transition-colors',
        over ? 'border-primary bg-primary/5' : 'border-border bg-surface',
      )}
    >
      <div className="text-xs font-medium text-foreground mb-2">
        Фільтри <span className="text-muted-foreground font-normal">· умови вибірки</span>
      </div>
      {filters.length === 0 ? (
        <span className="text-xs text-muted-foreground italic">Перетягніть поля сюди</span>
      ) : (
        <div className="flex flex-col gap-2">
          {filters.map((f, i) => {
            const fld = fieldByKey.get(f.field);
            const enumVals = fld?.enumName ? enums[fld.enumName] : undefined;
            return (
              <div key={f.field} className="flex flex-wrap items-center gap-2 text-xs">
                <span className={cn('rounded-full px-2.5 py-1', chipTone(fld?.type ?? 'scalar'))}>
                  {fld?.label ?? f.field}
                </span>
                <select
                  value={f.op}
                  onChange={e => update(i, { op: e.target.value as ReportFilter['op'] })}
                  className="rounded border border-border bg-surface px-1.5 py-1"
                >
                  <option value="eq">=</option>
                  <option value="ne">≠</option>
                  <option value="in">в списку</option>
                  <option value="contains">містить</option>
                  <option value="gt">&gt;</option>
                  <option value="gte">≥</option>
                  <option value="lt">&lt;</option>
                  <option value="lte">≤</option>
                  <option value="isNull">порожнє</option>
                </select>
                {f.op !== 'isNull' &&
                  (f.op === 'in' ? (
                    // op=in: бек очікує масив; вводимо через кому або multi-select для enum
                    enumVals ? (
                      <select
                        multiple
                        value={Array.isArray(f.value) ? (f.value as string[]) : []}
                        onChange={e => {
                          const selected = Array.from(e.target.selectedOptions, o => o.value);
                          update(i, { value: selected });
                        }}
                        className="rounded border border-border bg-surface px-1.5 py-1 h-20"
                      >
                        {enumVals.map(v => (
                          <option key={v} value={v}>
                            {enumLabel(fld?.enumName, v)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={
                          Array.isArray(f.value)
                            ? (f.value as string[]).join(',')
                            : String(f.value ?? '')
                        }
                        onChange={e =>
                          update(i, {
                            value: e.target.value
                              ? e.target.value.split(',').map(s => s.trim())
                              : [],
                          })
                        }
                        placeholder="знач1,знач2"
                        className="rounded border border-border bg-surface px-2 py-1 w-40"
                      />
                    )
                  ) : enumVals ? (
                    <select
                      value={String(f.value ?? '')}
                      onChange={e => update(i, { value: e.target.value })}
                      className="rounded border border-border bg-surface px-1.5 py-1"
                    >
                      <option value="">—</option>
                      {enumVals.map(v => (
                        <option key={v} value={v}>
                          {enumLabel(fld?.enumName, v)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={String(f.value ?? '')}
                      onChange={e => update(i, { value: e.target.value })}
                      placeholder="значення"
                      className="rounded border border-border bg-surface px-2 py-1 w-40"
                    />
                  ))}
                <button
                  type="button"
                  aria-label="Прибрати"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(f.field)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Рендер результату (ієрархічна таблиця) ──────────────────────────────────────

/**
 * Форматує значення агрегату за alias і типом поля.
 * MIN/MAX над датою → fmtDate (бекенд повертає Unix-мс від Prisma Date);
 * COUNT → ціле число; решта (SUM/AVG/MIN/MAX числових/decimal) → fmtMoney.
 *
 * Bug #620: тип поля резолвиться спочатку з `aggregations` (backend Bug #620 fix — містить
 * `type` для кожного агрегованого поля), потім (для сумісності) з `cols`. Це критично для
 * MIN/MAX-дати коли поле НЕ у `columns` — інакше рендериться як гроші.
 */
export function fmtAggValue(
  alias: string,
  value: number | null,
  cols?: { key: string; label: string; type: string }[],
  aggregations?: { field: string; agg: string; type?: string; label?: string }[],
): string {
  if (value === null || value === undefined) return '—';
  if (alias.startsWith('COUNT_')) return fmtInt(value);
  // Визначаємо тип поля за alias щоб відрізнити дати від чисел / money vs units.
  const us = alias.indexOf('_');
  const fieldKey = us >= 0 ? alias.slice(us + 1) : '';
  const aggType = aggregations?.find(a => a.field === fieldKey)?.type;
  const colType = aggType ?? cols?.find(c => c.key === fieldKey)?.type;
  if (colType === 'date') {
    // Prisma повертає Date-об'єкт; numericValue() → Number(date) = Unix-мс.
    if (!Number.isFinite(value)) return '—';
    return fmtDate(new Date(value));
  }
  // number = кількість (штуки/одиниці) — цілі без валюти; decimal = гроші (2 знаки).
  if (colType === 'number') {
    return Number.isInteger(value) ? fmtInt(value) : fmtMoney(value);
  }
  return fmtMoney(value);
}

/** Форматує значення детальної колонки за типом. `number` — кількість (без валюти),
 *  `decimal` — грошове (2 знаки). `boolean === false` пропускає early-return (строгі порівняння). */
function fmtCell(value: unknown, type: string, enumName?: string): string {
  if (type === 'boolean' && typeof value === 'boolean') return value ? 'Так' : 'Ні';
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'enum') return enumLabel(enumName, value);
  if (type === 'decimal') return fmtMoney(Number(value));
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? fmtInt(n) : fmtMoney(n);
  }
  if (type === 'date') return fmtDate(value as string | Date);
  return String(value);
}

/** enumName поля групування (за node.field). */
function displayGroupValue(node: GroupNode, enumByField: Record<string, string>): string {
  if (node.key === '∅') return '(порожньо)';
  const v = node.value;
  if (typeof v === 'boolean') return v ? 'Так' : 'Ні';
  const enumName = enumByField[node.field];
  if (enumName) return enumLabel(enumName, v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return fmtDate(v);
  }
  return String(v ?? node.key);
}

function ResultView({
  result,
  sort,
  onSort,
  enumByField,
}: {
  result: ReportRunResult;
  sort: { alias: string; dir: 'asc' | 'desc' } | null;
  onSort: (alias: string) => void;
  enumByField: Record<string, string>;
}) {
  const aggAliases = result.aggregations.map(a => `${a.agg}_${a.field}`);
  const cols = result.columns; // детальні колонки
  const hasGroups = result.groupBy.length > 0;
  // У плоскому режимі рядки склеєні (mergeDetailRows) → «Кількість» = скільки сирих рядків
  // склеєно (__mergedCount). Показуємо колонку якщо групи АБО якщо є склеювання (count>1
  // хоч в одному рядку — інакше distinct-1 не інформативний, ховаємо).
  const flatHasMerge = result.result.detailRows.some(
    r => typeof r.__mergedCount === 'number' && r.__mergedCount > 1,
  );
  const showCount = hasGroups || flatHasMerge;
  // Ширина labelу першої колонки + всі детальні колонки + (count?) + агрегати.
  const totalCols = 1 + cols.length + (showCount ? 1 : 0) + aggAliases.length;

  return (
    <div className="flex flex-1 min-h-0 flex-col rounded-xl border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary shrink-0">
        <span className="text-sm font-medium">
          Результат · рядків: {result.result.rowCount}
          {result.result.truncated && ' (обрізано до 5000 — звузьте період)'}
        </span>
      </div>
      {!hasGroups && (
        <div
          role="status"
          className="flex items-start gap-2 px-4 py-2 border-b border-border bg-amber-50 text-amber-900 text-[12.5px] shrink-0 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <span aria-hidden>ℹ️</span>
          <span>
            Групування не задано — показано детальні рядки. Щоб згрупувати (напр. за контрагентом,
            датою чи статусом) і побачити суми — натисніть кнопку{' '}
            <span className="font-semibold">Г</span> на потрібному полі в палітрі зліва.
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[13px] tabular-nums border-collapse">
          <thead className="sticky top-0 bg-secondary text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2 border-b border-border">
                {hasGroups ? 'Група' : '№'}
              </th>
              {cols.map(c => (
                <th
                  key={c.key}
                  className={cn(
                    'font-medium px-3 py-2 border-b border-border whitespace-nowrap',
                    c.type === 'decimal' || c.type === 'number' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.label}
                </th>
              ))}
              {showCount && (
                <th className="text-right font-medium px-3 py-2 border-b border-border whitespace-nowrap">
                  {/* У плоскому режимі колонка рахує СКІЛЬКИ рядків склеєно (mergeDetailRows) —
                      назва «Склеєно», щоб не збігатися з користувацькою колонкою даних «Кількість»
                      (напр. quantity), яка стоїть поруч і має інший сенс (сума). У режимі груп —
                      це кількість записів у групі (node.count), історична назва «Кількість». */}
                  {hasGroups ? 'Кількість' : 'Склеєно'}
                </th>
              )}
              {aggAliases.map(a => {
                const active = sort?.alias === a;
                const ariaSort: 'ascending' | 'descending' | 'none' = active
                  ? sort!.dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
                return (
                  <th
                    key={a}
                    aria-sort={ariaSort}
                    className="text-right font-medium px-3 py-2 border-b border-border whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => onSort(a)}
                      title="Сортувати групи за цим показником"
                      className={cn(
                        'inline-flex items-center gap-0.5 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        active && 'text-primary',
                      )}
                    >
                      {aggAliasLabel(a, result)}
                      {active && (sort!.dir === 'desc' ? '↓' : '↑')}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {hasGroups
              ? result.result.tree.map((n, i) => (
                  <GroupRows
                    key={n.key + i}
                    node={n}
                    depth={0}
                    cols={cols}
                    aggAliases={aggAliases}
                    aggregations={result.aggregations}
                    enumByField={enumByField}
                  />
                ))
              : // Без групування — плоска таблиця детальних рядків (діра #5).
                result.result.detailRows.map((row, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-4 py-1.5 text-muted-foreground">{i + 1}</td>
                    {cols.map(c => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-3 py-1.5',
                          c.type === 'decimal' || c.type === 'number' ? 'text-right' : 'text-left',
                        )}
                      >
                        {fmtCell(row[c.key], c.type, c.enumName)}
                      </td>
                    ))}
                    {showCount && (
                      <td className="text-right px-3 py-1.5 text-muted-foreground">
                        {typeof row.__mergedCount === 'number' ? row.__mergedCount : 1}
                      </td>
                    )}
                    {aggAliases.map(a => (
                      <td key={a} className="text-right px-3 py-1.5 text-muted-foreground">
                        —
                      </td>
                    ))}
                  </tr>
                ))}
            {!hasGroups && result.result.detailRows.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="px-4 py-6 text-center text-muted-foreground">
                  Немає даних
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold bg-muted/40">
              <td className="px-4 py-2 border-t border-border">Разом</td>
              {cols.map(c => (
                <td key={c.key} className="border-t border-border" />
              ))}
              {showCount && (
                <td className="text-right px-3 py-2 border-t border-border">
                  {result.result.rowCount}
                </td>
              )}
              {aggAliases.map(a => (
                <td key={a} className="text-right px-3 py-2 border-t border-border">
                  {fmtAggValue(a, result.result.grandTotals[a], cols, result.aggregations)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function aggAliasLabel(alias: string, result: ReportRunResult): string {
  const us = alias.indexOf('_');
  const agg = alias.slice(0, us);
  const fieldKey = alias.slice(us + 1);
  // Bug #620: агрегатне поле може бути ВНЕ `columns` (напр. MIN documentDate без
  // documentDate у колонках) — беремо label з `aggregations` (backend enrichment),
  // fallback на `columns`, потім на fieldKey.
  const aggMeta = result.aggregations.find(a => a.field === fieldKey);
  const col = result.columns.find(c => c.key === fieldKey);
  const label = aggMeta?.label ?? col?.label ?? fieldKey;
  // Короткий префікс (Σ Сума, сер. Ціна) — уникає «Сума: Сума» для авто-SUM грошових колонок.
  return `${AGG_SHORT[agg as Agg] ?? agg} ${label}`;
}

function GroupRows({
  node,
  depth,
  cols,
  aggAliases,
  aggregations,
  enumByField,
}: {
  node: GroupNode;
  depth: number;
  cols: { key: string; label: string; type: string; enumName?: string }[];
  aggAliases: string[];
  aggregations: { field: string; agg: string; type?: string; label?: string }[];
  enumByField: Record<string, string>;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const hasRows = !!node.rows && node.rows.length > 0;
  const expandable = hasChildren || hasRows;
  return (
    <>
      <tr className="border-b border-border">
        <td className="px-4 py-1.5" style={{ paddingLeft: `${16 + depth * 20}px` }}>
          <button
            type="button"
            onClick={() => expandable && setOpen(o => !o)}
            className={cn(
              'inline-flex items-center gap-1 text-left rounded',
              expandable &&
                'cursor-pointer hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            )}
            disabled={!expandable}
            aria-expanded={expandable ? open : undefined}
          >
            {expandable ? (
              open ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )
            ) : (
              <span className="inline-block w-3.5" />
            )}
            <span className={cn(depth === 0 && 'font-medium')}>
              {displayGroupValue(node, enumByField)}
            </span>
          </button>
        </td>
        {/* Детальні колонки у груповому рядку порожні (значення — у листкових рядках) */}
        {cols.map(c => (
          <td key={c.key} />
        ))}
        <td className="text-right px-3 py-1.5 text-muted-foreground">{node.count}</td>
        {aggAliases.map(a => (
          <td key={a} className="text-right px-3 py-1.5">
            {fmtAggValue(a, node.aggregates[a], cols, aggregations)}
          </td>
        ))}
      </tr>
      {open &&
        hasChildren &&
        node.children.map((c, i) => (
          <GroupRows
            key={c.key + i}
            node={c}
            depth={depth + 1}
            cols={cols}
            aggAliases={aggAliases}
            aggregations={aggregations}
            enumByField={enumByField}
          />
        ))}
      {open &&
        hasRows &&
        node.rows!.map((row, i) => (
          <tr key={`r${i}`} className="border-b border-border/50 bg-secondary/20">
            <td className="px-4 py-1" style={{ paddingLeft: `${16 + (depth + 1) * 20}px` }}>
              <span className="text-muted-foreground text-[12px]">запис {i + 1}</span>
            </td>
            {cols.map(c => (
              <td
                key={c.key}
                className={cn(
                  'px-3 py-1 text-[12px]',
                  c.type === 'decimal' || c.type === 'number' ? 'text-right' : 'text-left',
                )}
              >
                {fmtCell(row[c.key], c.type, c.enumName)}
              </td>
            ))}
            <td />
            {aggAliases.map(a => (
              <td key={a} />
            ))}
          </tr>
        ))}
    </>
  );
}

// ── Експорт CSV / XLSX (клієнтський, з дерева) ──────────────────────────────────
function flattenTree(nodes: GroupNode[], aggAliases: string[], depth = 0): string[][] {
  const rows: string[][] = [];
  for (const n of nodes) {
    const indent = '  '.repeat(depth);
    const label = n.key === '∅' ? '(порожньо)' : String(n.value ?? n.key);
    rows.push([
      indent + label,
      String(n.count),
      ...aggAliases.map(a => {
        const v = n.aggregates[a];
        return v === null || v === undefined ? '' : String(v);
      }),
    ]);
    if (n.children.length) rows.push(...flattenTree(n.children, aggAliases, depth + 1));
  }
  return rows;
}

/** Клітинка експорту для значення колонки: enum → переклад, дата → ДД.ММ.РРРР, число як є. */
function exportCell(value: unknown, type: string, enumName?: string): string {
  if (value === null || value === undefined) return '';
  if (enumName) return enumLabel(enumName, value);
  if (type === 'date') return fmtDate(String(value));
  return String(value);
}

function exportReport(result: ReportRunResult, format: 'csv' | 'xlsx') {
  const aggAliases = Object.keys(result.result.grandTotals);
  let rows: string[][];

  if (result.groupBy.length) {
    // Групований режим — дерево груп (як на екрані), відступ = рівень ієрархії.
    const header = ['Група', 'Кількість', ...aggAliases.map(a => aggAliasLabel(a, result))];
    const body = flattenTree(result.result.tree, aggAliases);
    const totals = [
      'Разом',
      String(result.result.rowCount),
      ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
    ];
    rows = [header, ...body, totals];
  } else {
    // Плоский режим — СКЛЕЄНІ детальні рядки (ті самі, що на екрані), а не лише «Усього».
    const cols = result.columns;
    const detail = result.result.detailRows;
    const showCount = detail.some(
      r => typeof r.__mergedCount === 'number' && (r.__mergedCount as number) > 1,
    );
    const header = [
      '№',
      ...cols.map(c => c.label),
      ...(showCount ? ['Склеєно'] : []),
      ...aggAliases.map(a => aggAliasLabel(a, result)),
    ];
    const body = detail.map((row, i) => [
      String(i + 1),
      ...cols.map(c => exportCell(row[c.key], c.type, c.enumName)),
      ...(showCount ? [String(typeof row.__mergedCount === 'number' ? row.__mergedCount : 1)] : []),
      ...aggAliases.map(() => ''),
    ]);
    const totals = [
      'Разом',
      ...cols.map(() => ''),
      ...(showCount ? [String(result.result.rowCount)] : []),
      ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
    ];
    rows = [header, ...body, totals];
  }

  if (format === 'csv') {
    const csv = rows
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    downloadBlob('﻿' + csv, `report-${result.entity}.csv`, 'text/csv;charset=utf-8;');
  } else {
    // XLSX через SpreadsheetML (простий, без бібліотеки) — відкривається Excel-ом.
    const xml = buildXlsxXml(rows);
    downloadBlob(xml, `report-${result.entity}.xls`, 'application/vnd.ms-excel');
  }
}

function buildXlsxXml(rows: string[][]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cells = (r: string[], isHeader: boolean) =>
    r
      .map((c, i) => {
        const num = i > 0 && c !== '' && !isNaN(Number(c));
        return num
          ? `<Cell><Data ss:Type="Number">${c}</Data></Cell>`
          : `<Cell><Data ss:Type="String">${esc(c)}</Data></Cell>`;
      })
      .join('');
  const body = rows.map((r, i) => `<Row>${cells(r, i === 0)}</Row>`).join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Звіт"><Table>${body}</Table></Worksheet></Workbook>`;
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Deferred revoke: Safari/Firefox інколи не встигають прочитати blob-URL до синхронного revoke.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
