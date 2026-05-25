'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkOrderLine {
  id: string; workId: string; workName?: string;
  employeeId: string; employeeName?: string;
  liftId?: string | null; normoHours: number; actualHours?: number | null; price: number; amount: number; notes?: string | null;
}
interface WorkOrderPart {
  id: string; goodId: string; goodName?: string;
  warehouseId: string; quantity: number; price: number; amount: number;
}
interface WorkOrderDetail {
  id: string; number: string; status: string;
  branchId: string; branchName?: string;
  vehicleId: string; vehicleSummary?: string;
  counterpartyId: string; counterpartyName?: string;
  description?: string | null; inMileage?: number | null; outMileage?: number | null;
  plannedAt?: string | null; completedAt?: string | null; dueDate?: string | null;
  priority?: string | null; repairCategory?: string | null; clientApproval?: boolean | null;
  totalLabor: number; totalParts: number; totalAmount: number; paidAmount: number;
  lines: WorkOrderLine[]; parts: WorkOrderPart[];
}

interface CompletionActSummary {
  id: string; number: string; status: 'DRAFT' | 'SIGNED' | 'CANCELLED';
  signedAt?: string | null; signedBy?: string | null;
}
interface Work { id: string; name: string; normoHours: number; price: number; }
interface Employee { id: string; firstName: string; lastName: string; }
interface Good { id: string; name: string; salePrice: number; }
interface Warehouse { id: string; name: string; }

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ESTIMATE: 'Кошторис', APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі', ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
  INVOICED: 'Виставлено', PAID: 'Оплачено', ARCHIVED: 'Архів', CANCELLED: 'Скасовано',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ESTIMATE: 'bg-warning-subtle text-warning',
  APPROVED: 'bg-primary-subtle text-primary',
  IN_PROGRESS: 'bg-purple-100 text-purple-700',
  ON_HOLD: 'bg-orange-100 text-orange-700',
  COMPLETED: 'bg-success-subtle text-success',
  INVOICED: 'bg-teal-100 text-teal-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  ARCHIVED: 'bg-secondary text-muted-foreground',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
};
const TRANSITION_LABELS: Record<string, string> = {
  ESTIMATE: 'Кошторис', APPROVED: 'Затвердити', IN_PROGRESS: 'В роботу',
  ON_HOLD: 'Призупинити', COMPLETED: 'Виконано', INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено', ARCHIVED: 'В архів', CANCELLED: 'Скасувати', DRAFT: 'Повернути в чернетку',
};
const TRANSITION_VARIANTS: Record<string, 'default' | 'destructive' | 'outline'> = {
  CANCELLED: 'destructive',
  COMPLETED: 'default',
  PAID: 'default',
  APPROVED: 'default',
  IN_PROGRESS: 'default',
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkOrderCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [completionAct, setCompletionAct] = useState<CompletionActSummary | null>(null);
  const [generatingAct, setGeneratingAct] = useState(false);
  const [signingAct, setSigningAct] = useState(false);

  const [lineModal, setLineModal] = useState(false);
  const [partModal, setPartModal] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refsError, setRefsError] = useState('');

  const [lineForm, setLineForm] = useState({ workId: '', employeeId: '', normoHours: '', price: '', notes: '' });
  const [partForm, setPartForm] = useState({ goodId: '', warehouseId: '', quantity: '1', price: '' });

  const load = useCallback(() => {
    apiFetch<WorkOrderDetail>(`/work-orders/${id}`)
      .then(setWo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження наряду'));
    apiFetch<{ items: CompletionActSummary[] }>(`/completion-acts?workOrderId=${id}`)
      .then(data => { if (data.items.length > 0) setCompletionAct(data.items[0]); })
      .catch(() => {});
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiFetch<{ items: Work[] }>('/works?limit=200').then(r => setWorks(r.items)).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<{ items: Employee[] }>('/employees?limit=200').then((r: { items?: Employee[] } | Employee[]) => setEmployees(Array.isArray(r) ? r : r.items ?? [])).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<{ items: Good[] }>('/goods?limit=200').then(r => setGoods(r.items)).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<Warehouse[]>('/warehouses').then(setWarehouses).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
  }, []);

  const selectWork = (workId: string) => {
    const w = works.find(x => x.id === workId);
    setLineForm(f => ({ ...f, workId, normoHours: w ? String(w.normoHours) : f.normoHours, price: w ? String(w.price) : f.price }));
  };

  const selectGood = (goodId: string) => {
    const g = goods.find(x => x.id === goodId);
    setPartForm(f => ({ ...f, goodId, price: g ? String(g.salePrice) : f.price }));
  };

  const addLine = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch<WorkOrderLine>(`/work-orders/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          workId: lineForm.workId,
          employeeId: lineForm.employeeId,
          normoHours: lineForm.normoHours ? Number(lineForm.normoHours) : undefined,
          price: lineForm.price ? Number(lineForm.price) : undefined,
          notes: lineForm.notes || undefined,
        }),
      });
      setLineModal(false);
      setLineForm({ workId: '', employeeId: '', normoHours: '', price: '', notes: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeLine = async (lineId: string) => {
    if (!confirm('Видалити роботу?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/work-orders/${id}/lines/${lineId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const addPart = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch<WorkOrderPart>(`/work-orders/${id}/parts`, {
        method: 'POST',
        body: JSON.stringify({
          goodId: partForm.goodId,
          warehouseId: partForm.warehouseId,
          quantity: Number(partForm.quantity),
          price: partForm.price ? Number(partForm.price) : undefined,
        }),
      });
      setPartModal(false);
      setPartForm({ goodId: '', warehouseId: '', quantity: '1', price: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removePart = async (partId: string) => {
    if (!confirm('Видалити запчастину?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/work-orders/${id}/parts/${partId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const transition = async (newStatus: string) => {
    const label = STATUS_LABELS[newStatus];
    if (!confirm(`Перевести наряд у статус "${label}"?`)) return;
    setTransitioning(true); setError('');
    try {
      await apiFetch<WorkOrderDetail>(`/work-orders/${id}/transition`, { method: 'POST', body: JSON.stringify({ status: newStatus }) });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка переходу'); }
    finally { setTransitioning(false); }
  };

  const generateAct = async () => {
    setGeneratingAct(true); setError('');
    try {
      const act = await apiFetch<CompletionActSummary>(`/completion-acts/from-work-order/${id}`, { method: 'POST' });
      setCompletionAct(act);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка формування акту'); }
    finally { setGeneratingAct(false); }
  };

  const signAct = async (actId: string) => {
    setSigningAct(true); setError('');
    try {
      const act = await apiFetch<CompletionActSummary>(`/completion-acts/${actId}/sign`, { method: 'PATCH' });
      setCompletionAct(act);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка підписання акту'); }
    finally { setSigningAct(false); }
  };

  if (!wo) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {error
        ? <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{error}</p>
        : <Spinner size="lg" />}
    </div>
  );

  const canEdit = ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(wo.status);
  const allowedTransitions = TRANSITIONS[wo.status] ?? [];

  return (
    <div className="page-container max-w-4xl space-y-6">
      {error && <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{error}</p>}
      {refsError && <p className="text-[13px] text-warning bg-warning-subtle border border-warning/20 rounded-lg px-4 py-2">Довідники: {refsError}</p>}

      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={() => router.back()} className="mt-1 text-muted-foreground hover:text-foreground text-sm">← Назад</button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{wo.number}</h1>
            <span className={cn('text-sm font-medium px-2.5 py-1 rounded-full', STATUS_COLORS[wo.status] ?? 'bg-secondary text-muted-foreground')}>
              {STATUS_LABELS[wo.status] ?? wo.status}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{wo.counterpartyName} · {wo.vehicleSummary}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-foreground">{wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
          <p className="text-xs text-muted-foreground">загальна сума</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-3 text-sm">
        {wo.branchName && <div><p className="text-xs text-muted-foreground">Філія</p><p className="text-foreground">{wo.branchName}</p></div>}
        {wo.priority && <div><p className="text-xs text-muted-foreground">Пріоритет</p><p className="text-foreground">{wo.priority}</p></div>}
        {wo.repairCategory && <div><p className="text-xs text-muted-foreground">Категорія ремонту</p><p className="text-foreground">{wo.repairCategory}</p></div>}
        {wo.dueDate && <div><p className="text-xs text-muted-foreground">Дедлайн</p><p className="text-foreground">{new Date(wo.dueDate).toLocaleDateString('uk-UA')}</p></div>}
        {wo.clientApproval != null && <div><p className="text-xs text-muted-foreground">Погодження клієнта</p><p className="text-foreground">{wo.clientApproval ? 'Так' : 'Ні'}</p></div>}
        {wo.inMileage != null && <div><p className="text-xs text-muted-foreground">Пробіг (вхід)</p><p className="text-foreground">{wo.inMileage.toLocaleString('uk-UA')} км</p></div>}
        {wo.outMileage != null && <div><p className="text-xs text-muted-foreground">Пробіг (вихід)</p><p className="text-foreground">{wo.outMileage.toLocaleString('uk-UA')} км</p></div>}
        {wo.plannedAt && <div><p className="text-xs text-muted-foreground">Заплановано</p><p className="text-foreground">{new Date(wo.plannedAt).toLocaleString('uk-UA')}</p></div>}
        {wo.description && <div className="col-span-2"><p className="text-xs text-muted-foreground">Опис</p><p className="text-foreground">{wo.description}</p></div>}
      </div>

      {/* FSM Buttons */}
      {allowedTransitions.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {allowedTransitions.map(s => (
            <Button
              key={s}
              variant={TRANSITION_VARIANTS[s] ?? 'outline'}
              onClick={() => transition(s)}
              disabled={transitioning}
              loading={transitioning}
            >
              {TRANSITION_LABELS[s] ?? s}
            </Button>
          ))}
        </div>
      )}

      {/* Totals */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-3 gap-4 text-sm">
        <div><p className="text-xs text-muted-foreground">Роботи</p><p className="text-lg font-semibold text-foreground">{wo.totalLabor.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
        <div><p className="text-xs text-muted-foreground">Запчастини</p><p className="text-lg font-semibold text-foreground">{wo.totalParts.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
        <div><p className="text-xs text-muted-foreground">Оплачено</p><p className={cn('text-lg font-semibold', wo.paidAmount >= wo.totalAmount ? 'text-success' : 'text-foreground')}>{wo.paidAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
      </div>

      {/* Completion Act */}
      {(['COMPLETED', 'INVOICED'].includes(wo.status) || completionAct) && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-foreground">Акт виконаних робіт</h2>
            {['COMPLETED', 'INVOICED'].includes(wo.status) && !completionAct && (
              <Button variant="outline" size="sm" onClick={generateAct} loading={generatingAct}>
                Сформувати акт
              </Button>
            )}
          </div>
          {completionAct ? (
            <div className="flex items-center gap-4 flex-wrap">
              <p className="text-sm font-medium text-foreground">Акт № {completionAct.number}</p>
              <span className={cn(
                'text-xs font-medium px-2 py-0.5 rounded-full',
                completionAct.status === 'SIGNED'    && 'bg-success-subtle text-success',
                completionAct.status === 'DRAFT'     && 'bg-secondary text-muted-foreground',
                completionAct.status === 'CANCELLED' && 'bg-destructive-subtle text-destructive',
              )}>
                {completionAct.status === 'DRAFT' ? 'Чернетка' : completionAct.status === 'SIGNED' ? 'Підписано' : 'Скасовано'}
              </span>
              {completionAct.signedAt && (
                <p className="text-xs text-muted-foreground">{new Date(completionAct.signedAt).toLocaleString('uk-UA')}</p>
              )}
              {completionAct.status === 'DRAFT' && (
                <Button variant="outline" size="sm" onClick={() => signAct(completionAct.id)} loading={signingAct}>
                  Позначити як підписано
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Акт не сформовано</p>
          )}
        </div>
      )}

      {/* Lines */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Роботи</h2>
          {canEdit && <button onClick={() => { setError(''); setLineModal(true); }} className="text-sm text-primary hover:underline">+ Робота</button>}
        </div>
        {wo.lines.length === 0
          ? <p className="text-sm text-muted-foreground">Роботи не додані</p>
          : (
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {wo.lines.map(l => (
                <div key={l.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">{l.workName}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.employeeName} · <span>{l.normoHours} н/г норм.</span>
                      {l.actualHours != null && (
                        <span className={cn(
                          'ml-1',
                          l.actualHours > l.normoHours ? 'text-warning font-medium' : 'text-muted-foreground/70',
                        )}>
                          {l.actualHours} н/г факт.
                        </span>
                      )}
                    </p>
                    {l.notes && <p className="text-xs text-muted-foreground mt-0.5">{l.notes}</p>}
                  </div>
                  <div className="text-right mr-3">
                    <p className="text-sm font-medium text-foreground">{l.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                    <p className="text-xs text-muted-foreground">{l.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} × {l.normoHours}</p>
                  </div>
                  {canEdit && <button onClick={() => removeLine(l.id)} className="text-xs text-destructive/60 hover:text-destructive px-1">×</button>}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* Parts */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Запчастини та матеріали</h2>
          {canEdit && (
            <div className="flex items-center gap-3">
              <XlsxImportButton
                templateType="wo-parts"
                importUrl={`/xlsx/import/work-order-parts/${id}`}
                onImportComplete={load}
              />
              <button onClick={() => { setError(''); setPartModal(true); }} className="text-sm text-primary hover:underline">+ Запчастина</button>
            </div>
          )}
        </div>
        {wo.parts.length === 0
          ? <p className="text-sm text-muted-foreground">Запчастини не додані</p>
          : (
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {wo.parts.map(p => (
                <div key={p.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">{p.goodName}</p>
                    <p className="text-xs text-muted-foreground">{p.quantity} шт × {p.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                  </div>
                  <div className="text-right mr-3">
                    <p className="text-sm font-medium text-foreground">{p.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                  </div>
                  {canEdit && <button onClick={() => removePart(p.id)} className="text-xs text-destructive/60 hover:text-destructive px-1">×</button>}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* Add Line Modal */}
      <Modal open={lineModal} onClose={() => setLineModal(false)} title="Додати роботу">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Робота <span className="text-red-500">*</span></label>
            <Select value={lineForm.workId} onChange={e => selectWork(e.target.value)}>
              <option value="">— Оберіть —</option>
              {works.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Виконавець <span className="text-red-500">*</span></label>
            <Select value={lineForm.employeeId} onChange={e => setLineForm(f => ({ ...f, employeeId: e.target.value }))}>
              <option value="">— Оберіть —</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Нормо-год</label>
              <Input type="number" value={lineForm.normoHours} onChange={e => setLineForm(f => ({ ...f, normoHours: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна, ₴</label>
              <Input type="number" value={lineForm.price} onChange={e => setLineForm(f => ({ ...f, price: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Нотатки</label>
            <Input value={lineForm.notes} onChange={e => setLineForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <Button onClick={addLine} loading={saving} disabled={!lineForm.workId || !lineForm.employeeId} className="w-full">
            Додати
          </Button>
        </div>
      </Modal>

      {/* Add Part Modal */}
      <Modal open={partModal} onClose={() => setPartModal(false)} title="Додати запчастину">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Товар <span className="text-red-500">*</span></label>
            <Select value={partForm.goodId} onChange={e => selectGood(e.target.value)}>
              <option value="">— Оберіть —</option>
              {goods.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Склад <span className="text-red-500">*</span></label>
            <Select value={partForm.warehouseId} onChange={e => setPartForm(f => ({ ...f, warehouseId: e.target.value }))}>
              <option value="">— Оберіть —</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Кількість <span className="text-red-500">*</span></label>
              <Input type="number" value={partForm.quantity} onChange={e => setPartForm(f => ({ ...f, quantity: e.target.value }))} min="0.001" step="0.001" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна, ₴</label>
              <Input type="number" value={partForm.price} onChange={e => setPartForm(f => ({ ...f, price: e.target.value }))} />
            </div>
          </div>
          <Button onClick={addPart} loading={saving} disabled={!partForm.goodId || !partForm.warehouseId || !partForm.quantity} className="w-full">
            Додати
          </Button>
        </div>
      </Modal>
    </div>
  );
}
