'use client';

import { useMemo, useState } from 'react';
import { X, ChevronRight, ChevronDown, Play, Save, Download } from 'lucide-react';
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
import { fmtMoney, fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Zone = 'columns' | 'groupBy' | 'filters';

const AGG_LABELS: Record<Agg, string> = {
  SUM: 'Сума',
  COUNT: 'Кількість',
  AVG: 'Середнє',
  MIN: 'Мінімум',
  MAX: 'Максимум',
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
  const [result, setResult] = useState<ReportRunResult | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const entity: MetaEntity | undefined = useMemo(
    () => meta?.entities.find(e => e.key === entityKey),
    [meta, entityKey],
  );
  const fieldByKey = useMemo(() => {
    const m = new Map<string, MetaField>();
    entity?.fields.forEach(f => m.set(f.key, f));
    return m;
  }, [entity]);

  // Поля, ще не додані у жодну зону — для палітри.
  const usedKeys = new Set([...columns, ...groupBy, ...filters.map(f => f.field)]);
  const paletteFields = entity?.fields.filter(f => !usedKeys.has(f.key)) ?? [];

  const resetSelection = (nextEntity: string) => {
    setEntityKey(nextEntity);
    setColumns([]);
    setGroupBy([]);
    setFilters([]);
    setAggs({});
    setResult(null);
  };

  // ── Drag (native HTML5): поле з палітри → зона; reorder усередині зони ──
  const onDropToZone = (zone: Zone, ev: React.DragEvent) => {
    ev.preventDefault();
    const key = ev.dataTransfer.getData('text/field');
    if (!key) return;
    const f = fieldByKey.get(key);
    if (!f) return;
    if (zone === 'groupBy') {
      if (!f.groupable) return toast.warning('Це поле не можна групувати');
      if (groupBy.length >= 5) return toast.warning('Максимум 5 рівнів групування');
      if (!groupBy.includes(key)) setGroupBy([...groupBy, key]);
    } else if (zone === 'columns') {
      if (!columns.includes(key)) setColumns([...columns, key]);
    } else {
      if (!f.filterable) return toast.warning('Це поле не фільтрується');
      if (!filters.some(x => x.field === key)) setFilters([...filters, { field: key, op: 'eq' }]);
    }
  };

  const removeFrom = (zone: Zone, key: string) => {
    if (zone === 'columns') setColumns(columns.filter(k => k !== key));
    else if (zone === 'groupBy') setGroupBy(groupBy.filter(k => k !== key));
    else setFilters(filters.filter(f => f.field !== key));
  };

  const buildConfig = (): ReportConfig => {
    const aggregations = Object.entries(aggs)
      .filter(([field]) => columns.includes(field))
      .map(([field, agg]) => ({ field, agg }));
    return {
      entity: entityKey,
      columns,
      groupBy,
      filters: filters.length ? filters : undefined,
      aggregations: aggregations.length ? aggregations : undefined,
      dateRange: from && to ? { from, to } : undefined,
    };
  };

  const run = async () => {
    if (!entityKey) return toast.warning('Оберіть джерело даних');
    if (!columns.length && !groupBy.length) return toast.warning('Додайте хоча б одну колонку');
    try {
      setResult(await runMut.mutateAsync(buildConfig()));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка звіту');
    }
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
    <div className="flex flex-col gap-4 py-4">
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
            <Button onClick={run} disabled={runMut.isPending}>
              <Play className="size-4" /> Запустити
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
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
          {/* Палітра полів */}
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Поля «{entity.label}» — перетягніть у зони
            </div>
            <div className="flex flex-wrap gap-1.5">
              {paletteFields.map(f => (
                <span
                  key={f.key}
                  draggable
                  onDragStart={e => e.dataTransfer.setData('text/field', f.key)}
                  className={cn(
                    'cursor-grab select-none rounded-full px-2.5 py-1 text-xs',
                    chipTone(f.type),
                  )}
                  title={isRelation(f.key) ? `Зв'язане поле: ${f.key}` : f.key}
                >
                  {f.label}
                </span>
              ))}
              {paletteFields.length === 0 && (
                <span className="text-xs text-muted-foreground">Усі поля використано</span>
              )}
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

            {result && <ResultView result={result} />}
          </div>
        </div>
      )}

      {saveOpen && (
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
      )}
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
  renderExtra,
  ordered,
}: {
  title: string;
  hint: string;
  zone: Zone;
  items: { key: string; field: MetaField | undefined }[];
  onDrop: (zone: Zone, ev: React.DragEvent) => void;
  onRemove: (zone: Zone, key: string) => void;
  renderExtra?: (f: MetaField | undefined) => React.ReactNode;
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
  onDrop: (zone: Zone, ev: React.DragEvent) => void;
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
                            {v}
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
                          {v}
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
function fmtAggValue(alias: string, value: number | null): string {
  if (value === null || value === undefined) return '—';
  if (alias.startsWith('COUNT_')) return String(value);
  return fmtMoney(value);
}

function ResultView({ result }: { result: ReportRunResult }) {
  const aggAliases = Object.keys(result.result.grandTotals);
  const hasGroups = result.groupBy.length > 0;
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary">
        <span className="text-sm font-medium">
          Результат · рядків: {result.result.rowCount}
          {result.result.truncated && ' (обрізано до 5000 — звузьте період)'}
        </span>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <table className="w-full text-[13px] tabular-nums border-collapse">
          <thead className="sticky top-0 bg-secondary text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2 border-b border-border">
                {hasGroups ? 'Група' : 'Рядок'}
              </th>
              <th className="text-right font-medium px-3 py-2 border-b border-border">Кількість</th>
              {aggAliases.map(a => (
                <th
                  key={a}
                  className="text-right font-medium px-3 py-2 border-b border-border whitespace-nowrap"
                >
                  {aggAliasLabel(a, result)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hasGroups ? (
              result.result.tree.map((n, i) => (
                <GroupRows key={n.key + i} node={n} depth={0} aggAliases={aggAliases} />
              ))
            ) : (
              <tr>
                <td className="px-4 py-2 border-b border-border text-muted-foreground">Усього</td>
                <td className="text-right px-3 py-2 border-b border-border">
                  {result.result.rowCount}
                </td>
                {aggAliases.map(a => (
                  <td key={a} className="text-right px-3 py-2 border-b border-border">
                    {fmtAggValue(a, result.result.grandTotals[a])}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold bg-muted/40">
              <td className="px-4 py-2 border-t border-border">Разом</td>
              <td className="text-right px-3 py-2 border-t border-border">
                {result.result.rowCount}
              </td>
              {aggAliases.map(a => (
                <td key={a} className="text-right px-3 py-2 border-t border-border">
                  {fmtAggValue(a, result.result.grandTotals[a])}
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
  const [agg, ...rest] = alias.split('_');
  const fieldKey = rest.join('_');
  const col = result.columns.find(c => c.key === fieldKey);
  return `${AGG_LABELS[agg as Agg] ?? agg}: ${col?.label ?? fieldKey}`;
}

function GroupRows({
  node,
  depth,
  aggAliases,
}: {
  node: GroupNode;
  depth: number;
  aggAliases: string[];
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const displayValue =
    node.key === '∅'
      ? '(порожньо)'
      : typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(node.value)
        ? fmtDate(node.value)
        : String(node.value ?? node.key);
  return (
    <>
      <tr
        className={cn(
          'border-b border-border',
          hasChildren && 'cursor-pointer hover:bg-secondary/40',
        )}
      >
        <td className="px-4 py-1.5" style={{ paddingLeft: `${16 + depth * 20}px` }}>
          <button
            type="button"
            onClick={() => hasChildren && setOpen(o => !o)}
            className="inline-flex items-center gap-1 text-left"
            disabled={!hasChildren}
          >
            {hasChildren ? (
              open ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )
            ) : (
              <span className="inline-block w-3.5" />
            )}
            <span className={cn(depth === 0 && 'font-medium')}>{displayValue}</span>
          </button>
        </td>
        <td className="text-right px-3 py-1.5 text-muted-foreground">{node.count}</td>
        {aggAliases.map(a => (
          <td key={a} className="text-right px-3 py-1.5">
            {fmtAggValue(a, node.aggregates[a])}
          </td>
        ))}
      </tr>
      {open &&
        node.children.map((c, i) => (
          <GroupRows key={c.key + i} node={c} depth={depth + 1} aggAliases={aggAliases} />
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

function exportReport(result: ReportRunResult, format: 'csv' | 'xlsx') {
  const aggAliases = Object.keys(result.result.grandTotals);
  const header = ['Група', 'Кількість', ...aggAliases.map(a => aggAliasLabel(a, result))];
  const body = result.groupBy.length
    ? flattenTree(result.result.tree, aggAliases)
    : [
        [
          'Усього',
          String(result.result.rowCount),
          ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
        ],
      ];
  const totals = [
    'Разом',
    String(result.result.rowCount),
    ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
  ];
  const rows = [header, ...body, totals];

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
  URL.revokeObjectURL(url);
}
