'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Search, Trash2, Layers, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  SERVICE_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceWork {
  workId: string;
  workName: string;
  normoHours: number;
  price: number;
  quantity: number;
}
interface ServiceGood {
  goodId: string;
  goodName: string;
  unit: string;
  salePrice: number;
  quantity: number;
}
interface Service {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  deletedAt?: string | null;
  works: ServiceWork[];
  goods: ServiceGood[];
}
interface PaginatedServices {
  items: Service[];
  total: number;
  page: number;
  limit: number;
}

interface ServicesFilters extends Record<string, unknown> {
  search: string;
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex justify-center gap-1.5 mt-4">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors ${
            p === page
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ─── Services Tab ─────────────────────────────────────────────────────────────

export default function ServicesTab() {
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('catalog-services');
  const panelConfig = useDetailPanelConfig('catalog-services-panel');
  const [services, setServices] = useState<PaginatedServices | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [form, setForm] = useState({ name: '', description: '', price: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  // Bug #309: in-flight set для restore — блокує дублюючі POST.
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());

  const SERVICES_COLUMNS = useMemo(
    () => [
      { key: 'name', label: 'Назва', defaultVisible: true },
      { key: 'price', label: 'Ціна, ₴', defaultVisible: true },
    ],
    [],
  );

  const {
    visibleKeys: servicesColVisible,
    visibleColumns: servicesVisibleColumns,
    orderedColumns: servicesOrderedColumns,
    order: servicesOrder,
    customLabels: servicesCustomLabels,
    toggle: toggleServicesCol,
    reorder: reorderServices,
    renameColumn: renameServicesCol,
    resetConfig: resetServicesConfig,
  } = useTableColumns('catalog-services', SERVICES_COLUMNS);
  const { dragProps: servicesDragProps } = useColumnDrag(
    servicesVisibleColumns,
    reorderServices,
    servicesOrderedColumns,
  );

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<ServicesFilters>('catalog-services');

  const applyFilter = useCallback((preset: { id: string; filters: ServicesFilters }) => {
    setQ(preset.filters.search ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search: q });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, q, features.toastEnabled],
  );

  // ── Bulk select ──────────────────────────────────────────────────────────────
  // Bug #328: `?? []` creates a fresh array literal each render → useBulkSelect prunes
  // every cycle. Use module-level frozen EMPTY_ITEMS for stable reference.
  const servicesItems = services?.items ?? (EMPTY_ITEMS as unknown as Service[]);
  const bulkSelect = useBulkSelect(servicesItems);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const servicesLoadRef = useRef<(() => void) | null>(null);

  const servicesActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        // Bug #313: useConfirm замість window.confirm.
        onClick: async ids => {
          if (
            !(await confirm({
              title: `Видалити ${ids.length} ${ids.length === 1 ? 'послугу' : 'послуг'}?`,
              variant: 'destructive',
            }))
          )
            return;
          const results = await Promise.allSettled(
            ids.map(id => apiFetch(`/services/${id}`, { method: 'DELETE' })),
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.length - succeeded;
          bulkSelect.clear();
          servicesLoadRef.current?.();
          if (features.toastEnabled) {
            if (failed === 0)
              toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'послугу' : 'послуг'}`);
            else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
          }
        },
      },
    ],
    [bulkSelect, features.toastEnabled, confirm],
  );

  // ── Unsaved guard ────────────────────────────────────────────────────────────
  const servicesFormDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // Bug #307: race-guard для swift showDeleted/q/page toggles — outdated response відкидається.
  const loadReqRef = useRef(0);
  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (debouncedQ) p.set('q', debouncedQ);
    if (showDeleted) p.set('showDeleted', 'true');
    const reqId = ++loadReqRef.current;
    apiFetch<PaginatedServices>(`/services?${p}`)
      .then(r => {
        if (loadReqRef.current !== reqId) return;
        setServices(r);
      })
      .catch((e: unknown) => {
        if (loadReqRef.current !== reqId) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (loadReqRef.current === reqId) setLoading(false);
      });
  }, [page, debouncedQ, showDeleted]);

  // Keep ref in sync so servicesActions can call load() without depending on it
  useEffect(() => {
    servicesLoadRef.current = load;
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditingService(null);
    setForm({ name: '', description: '', price: '' });
    servicesFormDirty.resetDirty();
    setError('');
    setModal(true);
  };

  const openEdit = (s: Service) => {
    setEditingService(s);
    setForm({
      name: s.name,
      description: s.description ?? '',
      price: s.price != null ? String(s.price) : '',
    });
    servicesFormDirty.resetDirty();
    setError('');
    setModal(true);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = {
        name: form.name,
        description: form.description || undefined,
        price: form.price ? Number(form.price) : undefined,
      };
      if (editingService) {
        await apiFetch(`/services/${editingService.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success('Послугу оновлено');
      } else {
        await apiFetch<Service>('/services', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Послугу створено');
      }
      setModal(false);
      setForm({ name: '', description: '', price: '' });
      servicesFormDirty.resetDirty();
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: 'Помітити послугу на видалення?',
        message: 'Можна відновити пізніше.',
        variant: 'destructive',
      }))
    )
      return;
    setDeletingId(id);
    setError('');
    try {
      await apiFetch<void>(`/services/${id}`, { method: 'DELETE' });
      if (selectedService?.id === id) setSelectedService(null);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeletingId(null);
    }
  };

  const restore = async (id: string) => {
    // Bug #309: in-flight guard + clear stale error.
    if (restoringIds.has(id)) return;
    setError('');
    setRestoringIds(prev => new Set(prev).add(id));
    try {
      await apiFetch<Service>(`/services/${id}/restore`, { method: 'POST' });
      load();
      if (features.toastEnabled) toast.success('Послугу відновлено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка відновлення');
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const totalPages = services ? Math.ceil(services.total / services.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {features.savedFiltersEnabled && (
        <SavedFiltersBar<ServicesFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      <div className="flex items-center gap-3 mb-3">
        <Input
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук послуг..."
          leftElement={<Search />}
          className="flex-1"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(d => !d);
              setPage(1);
            }}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={servicesOrderedColumns}
            visibleKeys={servicesColVisible}
            onToggle={toggleServicesCol}
            onReorder={reorderServices}
            onRename={renameServicesCol}
            onReset={resetServicesConfig}
            hasCustomization={
              JSON.stringify(servicesOrder) !== JSON.stringify(SERVICES_COLUMNS.map(c => c.key)) ||
              Object.keys(servicesCustomLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            Послуга
          </Button>
        </div>
      </div>

      {features.bulkActionsEnabled && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={[...bulkSelect.selected]}
          actions={servicesActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      <div className="flex">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-10">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      onChange={bulkSelect.toggleAll}
                      className="h-4 w-4 accent-primary"
                      aria-label="Обрати всі"
                    />
                  </TableHead>
                )}
                {servicesVisibleColumns.map(col => (
                  <TableHead key={col.key} {...servicesDragProps(col.key)}>
                    {col.label}
                  </TableHead>
                ))}
                <TableHead>Роботи</TableHead>
                <TableHead>Товари</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={servicesVisibleColumns.length + (features.bulkActionsEnabled ? 4 : 3)}
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && services?.items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={servicesVisibleColumns.length + (features.bulkActionsEnabled ? 4 : 3)}
                    className="p-0"
                  >
                    <EmptyState icon={Layers} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                services?.items.map(s => {
                  const isDeleted = !!s.deletedAt;
                  return (
                    <TableRow
                      key={s.id}
                      className={cn(
                        'group',
                        detailPanel.enabled && !isDeleted && 'cursor-pointer',
                        isDeleted
                          ? 'opacity-60 bg-secondary/30'
                          : selectedService?.id === s.id && detailPanel.enabled
                            ? 'bg-secondary'
                            : '',
                      )}
                      onClick={() => {
                        if (detailPanel.enabled && !isDeleted)
                          setSelectedService(prev => (prev?.id === s.id ? null : s));
                      }}
                    >
                      {features.bulkActionsEnabled && (
                        <TableCell onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={bulkSelect.isSelected(s.id)}
                            onChange={() => bulkSelect.toggle(s.id)}
                            className="h-4 w-4 accent-primary"
                            aria-label={`Обрати ${s.name}`}
                          />
                        </TableCell>
                      )}
                      {servicesVisibleColumns.map(col => {
                        if (col.key === 'name')
                          return (
                            <TableCell key="name">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p
                                  className={cn(
                                    'text-[13px] font-medium',
                                    isDeleted ? 'line-through text-muted-foreground' : '',
                                  )}
                                >
                                  {s.name}
                                </p>
                                {isDeleted && <Badge variant="secondary">видалено</Badge>}
                              </div>
                              {!isDeleted && s.description && (
                                <p className="text-[12px] text-muted-foreground">{s.description}</p>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'price')
                          return (
                            <TableCell key="price" className="font-medium text-foreground">
                              {s.price != null ? `${fmtMoney(s.price)} ₴` : 'авто'}
                            </TableCell>
                          );
                        return null;
                      })}
                      <TableCell className="text-muted-foreground">
                        {s.works.length > 0 ? s.works.map(w => w.workName).join(', ') : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.goods.length > 0 ? s.goods.map(g => g.goodName).join(', ') : '—'}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {isDeleted ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              loading={restoringIds.has(s.id)}
                              disabled={restoringIds.has(s.id)}
                              onClick={() => void restore(s.id)}
                              className="text-success/70 hover:text-success hover:bg-success/10"
                              title="Відновити"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title="Редагувати"
                                onClick={() => openEdit(s)}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                title="Помітити на видалення"
                                onClick={() => void remove(s.id)}
                                disabled={deletingId === s.id}
                                loading={deletingId === s.id}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>

        {(() => {
          const buildServiceTabs = (s: Service): DetailPanelTab[] => [
            {
              key: 'info',
              label: 'Основне',
              content: (
                <div className="space-y-3">
                  {buildPanelFields(s, SERVICE_PANEL_SCHEMA, panelConfig.config).map(f => (
                    <PanelField
                      key={f.key}
                      fieldKey={f.key}
                      label={f.label}
                      value={f.value}
                      hidden={f.hidden}
                    />
                  ))}
                </div>
              ),
            },
            {
              key: 'works',
              label: `Роботи (${s.works.length})`,
              content:
                s.works.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Немає</p>
                ) : (
                  <div className="space-y-2">
                    {s.works.map(w => (
                      <div
                        key={w.workId}
                        className="rounded-lg border border-border px-3 py-2 text-[13px]"
                      >
                        <p className="font-medium text-foreground">{w.workName}</p>
                        <p className="text-muted-foreground text-[12px] mt-0.5">
                          {w.quantity} × {w.normoHours} нормо-год · {fmtMoney(w.price)} ₴
                        </p>
                      </div>
                    ))}
                  </div>
                ),
            },
            {
              key: 'goods',
              label: `Товари (${s.goods.length})`,
              content:
                s.goods.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Немає</p>
                ) : (
                  <div className="space-y-2">
                    {s.goods.map(g => (
                      <div
                        key={g.goodId}
                        className="rounded-lg border border-border px-3 py-2 text-[13px]"
                      >
                        <p className="font-medium text-foreground">{g.goodName}</p>
                        <p className="text-muted-foreground text-[12px] mt-0.5">
                          {g.quantity} {g.unit} · {fmtMoney(g.salePrice)} ₴
                        </p>
                      </div>
                    ))}
                  </div>
                ),
            },
          ];
          return (
            <DetailPanel
              open={!!selectedService && detailPanel.enabled}
              onClose={() => setSelectedService(null)}
              title={selectedService?.name ?? ''}
              tabs={selectedService ? buildServiceTabs(selectedService) : undefined}
              configFields={schemaToPanelConfigFields(SERVICE_PANEL_SCHEMA, panelConfig.config)}
              onToggleField={panelConfig.toggleField}
              onReorderFields={panelConfig.reorderFields}
              onReset={panelConfig.reset}
            />
          );
        })()}
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Modal
        open={modal}
        onClose={async () => {
          if (!(await servicesFormDirty.confirmClose())) return;
          setModal(false);
        }}
        title={editingService ? 'Редагування послуги' : 'Нова комплексна послуга'}
        size="lg"
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name} className="w-full">
            {editingService ? 'Оновити' : 'Зберегти'}
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
            label="Назва"
            required
            value={form.name}
            onChange={e => {
              setForm(f => ({ ...f, name: e.target.value }));
              servicesFormDirty.markDirty();
            }}
            placeholder="ТО-1 (20 000 км)"
          />
          <Input
            label="Опис"
            value={form.description}
            onChange={e => {
              setForm(f => ({ ...f, description: e.target.value }));
              servicesFormDirty.markDirty();
            }}
          />
          <Input
            label="Фіксована ціна, ₴ (не заповнювати = авто)"
            type="number"
            min="0"
            value={form.price}
            onChange={e => {
              setForm(f => ({ ...f, price: e.target.value }));
              servicesFormDirty.markDirty();
            }}
            placeholder="2500"
          />
          <p className="text-[12px] text-muted-foreground">
            Роботи та товари можна додати після створення
          </p>
        </div>
      </Modal>
      <DirtyConfirmDialog {...servicesFormDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
