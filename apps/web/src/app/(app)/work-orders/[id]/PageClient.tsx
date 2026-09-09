'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateWorkOrderSideEffects } from '@/lib/cache-invalidation';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Spinner } from '@/components/ui/spinner';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtInt, fmtDate, fmtDateTime, fmtShortDateTime } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { toast } from '@/lib/toast';
import {
  WO_STATUS_LABELS,
  WO_STATUS_TRANSITIONS,
  WO_PRIORITY_LABELS,
  WO_PRIORITY_BADGE,
  WO_PRIORITY_DESCRIPTIONS,
  WO_CATEGORY_LABELS,
  WO_EDITABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
} from '@sto/shared';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Badge } from '@/components/ui/badge';
import { WorkOrderLinesSection } from './WorkOrderLinesSection';
import { WorkOrderPartsSection } from './WorkOrderPartsSection';
import { WorkOrderMediaSection } from './WorkOrderMediaSection';
import { WarrantySection } from './WarrantySection';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { WorkOrderAuditSection } from './WorkOrderAuditSection';
import { InvoiceSection, type InvoiceRef } from './InvoiceSection';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkOrderMedia {
  id: string;
  workOrderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  signedUrl: string;
  createdAt: string;
}

interface AuditEventItem {
  id: string;
  action: string;
  diff: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string };
}

interface WorkOrderLine {
  id: string;
  workOrderId?: string;
  workId: string;
  workName?: string;
  employeeId: string;
  employeeName?: string;
  liftId?: string | null;
  normoHours: number;
  actualHours?: number | null;
  price: number;
  amount: number;
  notes?: string | null;
  createdAt?: string;
}
interface WorkOrderPart {
  id: string;
  workOrderId?: string;
  goodId: string;
  goodName?: string;
  goodInternalCode?: string | null;
  goodSku?: string | null;
  goodBrandName?: string | null;
  unitOfMeasureId?: string | null;
  unitShortName?: string;
  coefficient?: number;
  warehouseId: string;
  quantity: number;
  costPrice?: number | null;
  price: number;
  amount: number;
  createdAt?: string;
}
interface WorkOrderDetail {
  id: string;
  orgId?: string;
  number: string;
  status: string;
  branchId: string;
  branchName?: string;
  vehicleId: string;
  vehicleSummary?: string;
  counterpartyId: string;
  counterpartyName?: string;
  contractId?: string | null;
  contractNumber?: string | null;
  liftId?: string | null;
  liftName?: string | null;
  description?: string | null;
  inMileage?: number | null;
  outMileage?: number | null;
  plannedAt?: string | null;
  completedAt?: string | null;
  dueDate?: string | null;
  plannedHours?: number | null;
  actualHours?: number | null;
  priority?: string;
  repairCategory?: string | null;
  clientApproval?: boolean;
  documentDate?: string | null;
  totalLabor: number;
  totalActualLabor: number;
  totalParts: number;
  totalAmount: number;
  totalVat?: number;
  paidAmount: number;
  hasActiveWarranty?: boolean;
  slotStartAt?: string | null;
  slotEndAt?: string | null;
  slotLiftName?: string | null;
  updatedAt?: string;
  lines: WorkOrderLine[];
  parts: WorkOrderPart[];
}

interface Comment {
  id: string;
  orgId: string;
  entityType: string;
  entityId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

interface CompletionActSummary {
  id: string;
  number: string;
  status: 'DRAFT' | 'SIGNED' | 'CANCELLED';
  signedAt?: string | null;
  signedBy?: string | null;
  clientPhone?: string | null;
  notes?: string | null;
}
interface Work {
  id: string;
  name: string;
  normoHours: number;
  price: number;
}
interface Employee {
  id: string;
  firstName: string;
  lastName: string;
}
interface Good {
  id: string;
  name: string;
  sku?: string;
  salePrice: number;
}
interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
}

// ─── Inspection ───────────────────────────────────────────────────────────────
interface InspectionPoint {
  name: string;
  value: string;
  unit: string;
  status: 'OK' | 'WARN' | 'CRITICAL';
  notes?: string;
}
interface InspectionReport {
  id: string;
  mileage?: number | null;
  points: InspectionPoint[];
  createdAt: string;
  autoCreatedLines?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Status labels imported from @sto/shared
const STATUS_LABELS = WO_STATUS_LABELS;
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ESTIMATE: 'bg-warning-subtle text-warning',
  APPROVED: 'bg-primary-subtle text-primary',
  IN_PROGRESS: 'bg-info-subtle text-info-text',
  ON_HOLD: 'bg-warning-subtle text-warning',
  COMPLETED: 'bg-success-subtle text-success',
  INVOICED: 'bg-primary-subtle text-primary',
  PAID: 'bg-success-subtle text-success',
  ARCHIVED: 'bg-secondary text-muted-foreground',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};
// Single source of truth: WO_STATUS_TRANSITIONS in @sto/shared mirrors the
// backend WORK_ORDER_TRANSITIONS map. Local fallback for terminal statuses
// (ARCHIVED/CANCELLED → []) so `?? []` is unnecessary at call sites.
const TRANSITIONS = WO_STATUS_TRANSITIONS;
const TRANSITION_LABELS: Record<string, string> = {
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затвердити',
  IN_PROGRESS: 'В роботу',
  ON_HOLD: 'Призупинити',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено',
  ARCHIVED: 'В архів',
  CANCELLED: 'Скасувати',
  DRAFT: 'Повернути в чернетку',
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
  const { confirm, dialogProps } = useConfirm();
  const { employee } = useAuth();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [woLoading, setWoLoading] = useState(true);
  const [works, setWorks] = useState<Work[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [completionAct, setCompletionAct] = useState<CompletionActSummary | null>(null);
  const [generatingAct, setGeneratingAct] = useState(false);
  const [signingAct, setSigningAct] = useState(false);
  const [cancellingAct, setCancellingAct] = useState(false);
  const [downloadingActPdf, setDownloadingActPdf] = useState(false);

  // undefined = not yet loaded; null = loaded but no invoice; InvoiceRef = present.
  const [invoiceRef, setInvoiceRef] = useState<InvoiceRef | null | undefined>(undefined);

  const queryClient = useQueryClient();
  const [transitioning, setTransitioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refsError, setRefsError] = useState('');

  // initialWarehouseId зберігається між послідовними додаваннями запчастин — щоб
  // MECHANIC не перевибирав один і той самий склад на кожному додаванні.
  const [initialPartWarehouseId, setInitialPartWarehouseId] = useState('');

  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);

  // Inspection state
  const [inspection, setInspection] = useState<InspectionReport | null>(null);
  const [inspectionPoints, setInspectionPoints] = useState<InspectionPoint[]>([]);
  const [showInspection, setShowInspection] = useState(false);
  const [savingInspection, setSavingInspection] = useState(false);
  const [inspMileage, setInspMileage] = useState('');

  const [media, setMedia] = useState<WorkOrderMedia[]>([]);

  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>([]);

  const [savingTemplate, setSavingTemplate] = useState(false);

  const features = useUiFeatures();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    // Parallel fetch — work-order detail, completion-acts list and inspection report
    // are independent endpoints; previous fire-and-forget pattern coalesced their
    // browser-level scheduling but failed to surface the inspection-load error
    // separately from the WO load error. Promise.all preserves both behaviours.
    Promise.all([
      apiFetch<WorkOrderDetail>(`/work-orders/${id}`).then(
        data => ({ kind: 'wo' as const, data }),
        (e: unknown) => ({ kind: 'wo-error' as const, error: e }),
      ),
      apiFetch<{ items: CompletionActSummary[] }>(`/completion-acts?workOrderId=${id}`).catch(
        (e: unknown) => {
          console.warn('[CompletionAct] load failed:', e);
          return { items: [] as CompletionActSummary[] };
        },
      ),
      apiFetch<InspectionReport | null>(`/work-orders/${id}/inspection`).catch(() => null),
      apiFetch<InvoiceRef | null>(`/invoices/from-work-order/${id}/find`).catch(() => null),
    ]).then(([woResult, acts, inspectionData, invoiceData]) => {
      if (!mountedRef.current) return;
      setWoLoading(false);
      if (woResult.kind === 'wo') {
        setWo(woResult.data);
      } else {
        setError(
          woResult.error instanceof Error ? woResult.error.message : 'Помилка завантаження наряду',
        );
      }
      if (acts.items.length > 0) setCompletionAct(acts.items[0]);
      setInspection(inspectionData);
      setInvoiceRef(invoiceData);
    });
  }, [id]);

  // Load secondary data (comments, media, audit) in parallel — single effect, single mount
  const loadSecondary = useCallback(() => {
    Promise.all([
      apiFetch<{ items: Comment[] }>(`/comments?entityType=WorkOrder&entityId=${id}`).catch(() => ({
        items: [] as Comment[],
      })),
      apiFetch<{ items: WorkOrderMedia[] }>(`/work-orders/${id}/media`).catch(() => ({
        items: [] as WorkOrderMedia[],
      })),
      apiFetch<{ items: AuditEventItem[] }>(`/audit?entityType=WorkOrder&entityId=${id}`).catch(
        () => ({ items: [] as AuditEventItem[] }),
      ),
    ]).then(([comments, media, audit]) => {
      if (!mountedRef.current) return;
      setComments(comments.items ?? []);
      setMedia(media.items ?? []);
      setAuditEvents(audit.items ?? []);
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadSecondary();
  }, [loadSecondary]);

  const loadComments = useCallback(() => {
    apiFetch<{ items: Comment[] }>(`/comments?entityType=WorkOrder&entityId=${id}`)
      .then(r => {
        if (mountedRef.current) setComments(r.items ?? []);
      })
      .catch((e: unknown) => {
        // silent .catch ховало помилки завантаження коментарів — діагностика
        // неможлива. Тепер логуємо у console.warn (тісно з review patten 88d2c8d).
        console.warn('Помилка завантаження коментарів:', e);
      });
  }, [id]);

  const loadMedia = useCallback(() => {
    apiFetch<{ items: WorkOrderMedia[] }>(`/work-orders/${id}/media`)
      .then(d => {
        if (mountedRef.current) setMedia(d.items ?? []);
      })
      .catch((e: unknown) => {
        // silent .catch ховало помилки завантаження медіа — debug-ability fix.
        console.warn('Помилка завантаження медіа наряду:', e);
      });
  }, [id]);

  const saveAsTemplate = async () => {
    if (!wo) return;
    const name = window.prompt('Назва шаблону:', wo.number || 'Новий шаблон');
    if (!name?.trim()) return;
    setSavingTemplate(true);
    try {
      await apiFetch('/work-order-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          lines: wo.lines.map(l => ({
            workId: l.workId,
            quantity: l.normoHours,
            note: l.notes ?? undefined,
          })),
          parts: wo.parts.map(p => ({ goodId: p.goodId, quantity: p.quantity })),
        }),
      });
      if (features.toastEnabled) toast.success(`Шаблон "${name.trim()}" збережено`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження шаблону';
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSavingTemplate(false);
    }
  };

  const submitComment = async () => {
    if (!commentBody.trim()) return;
    setCommentSaving(true);
    try {
      await apiFetch(`/comments`, {
        method: 'POST',
        body: JSON.stringify({ entityType: 'WorkOrder', entityId: id, body: commentBody.trim() }),
      });
      setCommentBody('');
      loadComments();
      if (features.toastEnabled) toast.success('Коментар додано');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setCommentSaving(false);
    }
  };

  useEffect(() => {
    // Reference data — paint instantly from sessionStorage, refresh in background.
    // Без кешу кожне відкриття картки наряду тягне ~600 рядків (works+employees+warehouses)
    // навіть якщо користувач відкриває третю поспіль картку за хвилину.
    const cachedWorks = getCached<Work[]>('cache:works');
    const cachedEmployees = getCached<Employee[]>('cache:employees');
    const cachedWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cachedWorks) setWorks(cachedWorks);
    if (cachedEmployees) setEmployees(cachedEmployees);
    if (cachedWarehouses) {
      setWarehouses(cachedWarehouses);
      const mainW =
        cachedWarehouses.find(x => x.isMain) ??
        (cachedWarehouses.length === 1 ? cachedWarehouses[0] : null);
      if (mainW) setInitialPartWarehouseId(curr => curr || mainW.id);
    }

    apiFetch<{ items: Work[] }>('/works?limit=200')
      .then(r => {
        setCache('cache:works', r.items);
        if (mountedRef.current) setWorks(r.items);
      })
      .catch((e: unknown) => {
        if (mountedRef.current && !cachedWorks)
          setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });
    apiFetch<{ items: Employee[] }>('/employees?limit=200')
      .then((r: { items?: Employee[] } | Employee[]) => {
        const arr = Array.isArray(r) ? r : (r.items ?? []);
        setCache('cache:employees', arr);
        if (mountedRef.current) setEmployees(arr);
      })
      .catch((e: unknown) => {
        if (mountedRef.current && !cachedEmployees)
          setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });
    apiFetch<Warehouse[]>('/warehouses')
      .then(data => {
        setCache('cache:warehouses', data);
        if (!mountedRef.current) return;
        setWarehouses(data);
        const mainW = data.find(x => x.isMain) ?? (data.length === 1 ? data[0] : null);
        // Preserve a warehouse the user has already chosen manually — only
        // pre-fill when the field is still empty.
        if (mainW) setInitialPartWarehouseId(curr => curr || mainW.id);
      })
      .catch((e: unknown) => {
        if (mountedRef.current && !cachedWarehouses)
          setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });
    apiFetch<InspectionPoint[]>(`/work-orders/${id}/inspection/default-points`)
      .then(d => {
        if (mountedRef.current) setInspectionPoints(d);
      })
      .catch((e: unknown) => {
        // silent .catch ховало помилки завантаження inspection-points —
        // debug-ability fix (тісно з review patten 88d2c8d).
        console.warn('Помилка завантаження точок огляду:', e);
      });
  }, [id]);

  const transition = async (newStatus: string) => {
    const label = STATUS_LABELS[newStatus];
    if (!(await confirm({ title: `Перевести наряд у статус "${label}"?` }))) return;
    if (!wo) return;

    const previousStatus = wo.status;

    // Optimistic update — одразу показуємо новий статус у UI
    setWo(prev => (prev ? { ...prev, status: newStatus } : prev));
    setTransitioning(true);
    setError('');
    try {
      const updated = await apiFetch<Omit<WorkOrderDetail, 'lines' | 'parts'>>(
        `/work-orders/${id}/transition`,
        { method: 'POST', body: JSON.stringify({ status: newStatus }) },
      );
      // transition returns WorkOrderResponseDto (no lines/parts) — merge with existing
      setWo(prev => (prev ? { ...prev, ...updated } : prev));
      // WEB-H1: перехід рухає склад (writeoff) + баланс (CHARGE) → інвалідувати сусідні кеші
      // (інвентар/взаєморозрахунки/звіти/дашборд), інакше інші вкладки застарілі.
      invalidateWorkOrderSideEffects(queryClient);
      if (features.toastEnabled) toast.success(`Статус змінено: ${label}`);
    } catch (e: unknown) {
      // Rollback
      setWo(prev => (prev ? { ...prev, status: previousStatus } : prev));
      const msg = e instanceof Error ? e.message : 'Помилка переходу';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setTransitioning(false);
    }
  };

  const generateAct = async () => {
    setGeneratingAct(true);
    setError('');
    try {
      const act = await apiFetch<CompletionActSummary>(`/completion-acts/from-work-order/${id}`, {
        method: 'POST',
      });
      setCompletionAct(act);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка формування акту');
    } finally {
      setGeneratingAct(false);
    }
  };

  const [cloning, setCloning] = useState(false);

  // ── Редагування реквізитів ────────────────────────────────────────────────
  const [editModal, setEditModal] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    documentDate: '',
    priority: '',
    repairCategory: '',
    description: '',
    inMileage: '',
    dueDate: '',
    clientApproval: false,
  });

  const openEditModal = () => {
    if (!wo) return;
    setEditForm({
      documentDate: wo.documentDate ?? '',
      priority: wo.priority ?? 'NORMAL',
      repairCategory: wo.repairCategory ?? '',
      description: wo.description ?? '',
      inMileage: wo.inMileage != null ? String(wo.inMileage) : '',
      dueDate: wo.dueDate ? wo.dueDate.slice(0, 10) : '',
      clientApproval: wo.clientApproval ?? false,
    });
    setEditModal(true);
  };

  const saveEdit = async () => {
    if (!wo) return;
    setEditSaving(true);
    setError('');
    try {
      const updated = await apiFetch<Partial<WorkOrderDetail>>(`/work-orders/${wo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          documentDate: editForm.documentDate || undefined,
          priority: editForm.priority || undefined,
          repairCategory: editForm.repairCategory || undefined,
          description: editForm.description || undefined,
          inMileage: editForm.inMileage ? Number(editForm.inMileage) : undefined,
          dueDate: editForm.dueDate || undefined,
          clientApproval: editForm.clientApproval,
        }),
      });
      // PATCH returns WorkOrderResponseDto without lines/parts — merge to preserve them
      setWo(prev => (prev ? { ...prev, ...updated } : prev));
      setEditModal(false);
      toast.success('Реквізити збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditSaving(false);
    }
  };

  const downloadPdf = async () => {
    // use apiBlobFetch which does silent refresh on 401 — direct fetch
    // breaks when access token expired (~15min) requiring full page reload.
    setError('');
    try {
      const blob = await apiBlobFetch(`/work-orders/${id}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `work-order-${wo?.number ?? id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke — Chromium can drop the download if revoke fires before the browser starts reading.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження PDF');
    }
  };

  const handleClone = async () => {
    setCloning(true);
    setError('');
    try {
      const cloned = await apiFetch<{ id: string }>(`/work-orders/${id}/clone`, { method: 'POST' });
      router.push(`/work-orders/${cloned.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка дублювання');
    } finally {
      setCloning(false);
    }
  };

  const downloadActPdf = async (actId: string) => {
    setDownloadingActPdf(true);
    setError('');
    try {
      // same silent-refresh hardening as downloadPdf above.
      const blob = await apiBlobFetch(`/completion-acts/${actId}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `act-${completionAct?.number ?? actId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження PDF акту');
    } finally {
      setDownloadingActPdf(false);
    }
  };

  const signAct = async (actId: string) => {
    setSigningAct(true);
    setError('');
    try {
      const act = await apiFetch<CompletionActSummary>(`/completion-acts/${actId}/sign`, {
        method: 'PATCH',
      });
      setCompletionAct(act);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка підписання акту');
    } finally {
      setSigningAct(false);
    }
  };

  const cancelAct = async (actId: string) => {
    if (!(await confirm({ title: 'Скасувати акт виконаних робіт?', variant: 'destructive' })))
      return;
    setCancellingAct(true);
    setError('');
    try {
      await apiFetch(`/completion-acts/${actId}`, { method: 'DELETE' });
      setCompletionAct(null);
      if (features.toastEnabled) toast.success('Акт скасовано');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка скасування акту');
    } finally {
      setCancellingAct(false);
    }
  };

  const saveInspection = async () => {
    setSavingInspection(true);
    try {
      const result = await apiFetch<InspectionReport & { autoCreatedLines: number }>(
        `/work-orders/${id}/inspection`,
        {
          method: 'POST',
          body: JSON.stringify({
            mileage: inspMileage ? Number(inspMileage) : undefined,
            points: inspectionPoints,
          }),
        },
      );
      setInspection(result);
      setShowInspection(false);
      if (result.autoCreatedLines > 0) {
        load();
      }
      if (features.toastEnabled) toast.success('Огляд збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження огляду');
    } finally {
      setSavingInspection(false);
    }
  };

  if (!wo)
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        {error ? (
          <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
            {error}
          </p>
        ) : woLoading ? (
          <Spinner size="lg" />
        ) : (
          <p className="text-[13px] text-muted-foreground">Наряд не знайдено</p>
        )}
      </div>
    );

  const canEdit = WO_EDITABLE_STATUSES.includes(wo.status);
  const allowedTransitions = TRANSITIONS[wo.status] ?? [];

  return (
    <div className="page-container max-w-4xl space-y-6">
      {error && (
        <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
          {error}
        </p>
      )}
      {refsError && (
        <p className="text-[13px] text-warning bg-warning-subtle border border-warning/20 rounded-lg px-4 py-2">
          Довідники: {refsError}
        </p>
      )}

      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => router.back()}
          className="mt-1 text-muted-foreground hover:text-foreground text-sm"
        >
          ← Назад
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{wo.number}</h1>
            <span
              className={cn(
                'text-sm font-medium px-2.5 py-1 rounded-full',
                STATUS_COLORS[wo.status] ?? 'bg-secondary text-muted-foreground',
              )}
            >
              {STATUS_LABELS[wo.status] ?? wo.status}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {wo.counterpartyName} · {wo.vehicleSummary}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-foreground">{fmtMoney(wo.totalAmount)} ₴</p>
          <p className="text-xs text-muted-foreground">загальна сума</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-surface rounded-xl border border-border p-5 text-sm">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Реквізити
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={openEditModal}
            className="h-7 text-[12px] gap-1.5"
          >
            <Pencil className="h-3.5 w-3.5" />
            Редагувати
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {wo.documentDate && (
            <div>
              <p className="text-xs text-muted-foreground">Дата документа</p>
              <p className="text-foreground font-medium">{fmtDate(wo.documentDate)}</p>
            </div>
          )}
          {wo.branchName && (
            <div>
              <p className="text-xs text-muted-foreground">Філія</p>
              <p className="text-foreground">{wo.branchName}</p>
            </div>
          )}
          {wo.contractNumber && (
            <div>
              <p className="text-xs text-muted-foreground">Договір</p>
              <p className="text-foreground">{wo.contractNumber}</p>
            </div>
          )}
          {wo.priority && (
            <div>
              <p className="text-xs text-muted-foreground">Пріоритет</p>
              <Badge
                variant={WO_PRIORITY_BADGE[wo.priority] ?? 'secondary'}
                className="mt-0.5"
                tooltip={WO_PRIORITY_DESCRIPTIONS[wo.priority]}
              >
                {WO_PRIORITY_LABELS[wo.priority] ?? wo.priority}
              </Badge>
            </div>
          )}
          {wo.repairCategory && (
            <div>
              <p className="text-xs text-muted-foreground">Категорія ремонту</p>
              <p className="text-foreground">
                {WO_CATEGORY_LABELS[wo.repairCategory] ?? wo.repairCategory}
              </p>
            </div>
          )}
          {wo.dueDate && (
            <div>
              <p className="text-xs text-muted-foreground">Дедлайн</p>
              <p className="text-foreground">{fmtDate(wo.dueDate)}</p>
            </div>
          )}
          {wo.clientApproval != null && (
            <div>
              <p className="text-xs text-muted-foreground">Погодження клієнта</p>
              <p className="text-foreground">{wo.clientApproval === true ? 'Так' : 'Ні'}</p>
            </div>
          )}
          {wo.inMileage != null && (
            <div>
              <p className="text-xs text-muted-foreground">Пробіг (вхід)</p>
              <p className="text-foreground">{fmtInt(wo.inMileage)} км</p>
            </div>
          )}
          {wo.outMileage != null && (
            <div>
              <p className="text-xs text-muted-foreground">Пробіг (вихід)</p>
              <p className="text-foreground">{fmtInt(wo.outMileage)} км</p>
            </div>
          )}
          {wo.plannedAt && (
            <div>
              <p className="text-xs text-muted-foreground">Заплановано</p>
              <p className="text-foreground">{fmtDateTime(wo.plannedAt)}</p>
            </div>
          )}
          {wo.description && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Опис</p>
              <p className="text-foreground">{wo.description}</p>
            </div>
          )}
        </div>
      </div>

      {/* FSM Buttons */}
      <div className="flex gap-2 flex-wrap items-center">
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
        <Button variant="outline" size="sm" onClick={downloadPdf}>
          PDF
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          Друк
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClone}
          loading={cloning}
          disabled={cloning}
        >
          Дублювати
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void saveAsTemplate()}
          loading={savingTemplate}
          disabled={savingTemplate || (!wo?.lines.length && !wo?.parts.length)}
        >
          Шаблон ↓
        </Button>
      </div>

      {/* Totals */}
      {/* Bug #506: коли totalActualLabor !== totalLabor (механік ввів фактичні години),
          показуємо обидва значення щоб математика сходилась з totalAmount у header.
          totalAmount = totalActualLabor + totalParts (бекенд recalcTotals). */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-3 gap-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">
            {wo.totalActualLabor !== wo.totalLabor ? 'Роботи (план)' : 'Роботи'}
          </p>
          <p className="text-lg font-semibold text-foreground">{fmtMoney(wo.totalLabor)} ₴</p>
          {wo.totalActualLabor !== wo.totalLabor && (
            <p className="text-xs text-muted-foreground mt-1">
              факт.:{' '}
              <span className="font-medium text-foreground">{fmtMoney(wo.totalActualLabor)} ₴</span>
            </p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Запчастини</p>
          <p className="text-lg font-semibold text-foreground">{fmtMoney(wo.totalParts)} ₴</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Оплачено</p>
          <p
            className={cn(
              'text-lg font-semibold',
              wo.paidAmount >= wo.totalAmount ? 'text-success' : 'text-foreground',
            )}
          >
            {fmtMoney(wo.paidAmount)} ₴
          </p>
        </div>
      </div>

      {/* Completion Act */}
      {(WO_INVOICEABLE_STATUSES.includes(wo.status) || completionAct) && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-foreground">Акт виконаних робіт</h2>
            {WO_INVOICEABLE_STATUSES.includes(wo.status) && !completionAct && (
              <Button variant="outline" size="sm" onClick={generateAct} loading={generatingAct}>
                Сформувати акт
              </Button>
            )}
          </div>
          {completionAct ? (
            <div className="flex items-center gap-4 flex-wrap">
              <p className="text-sm font-medium text-foreground">Акт № {completionAct.number}</p>
              <span
                className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full',
                  completionAct.status === 'SIGNED' && 'bg-success-subtle text-success',
                  completionAct.status === 'DRAFT' && 'bg-secondary text-muted-foreground',
                  completionAct.status === 'CANCELLED' && 'bg-destructive-subtle text-destructive',
                )}
              >
                {completionAct.status === 'DRAFT'
                  ? 'Чернетка'
                  : completionAct.status === 'SIGNED'
                    ? 'Підписано'
                    : 'Скасовано'}
              </span>
              {completionAct.signedAt && (
                <p className="text-xs text-muted-foreground">
                  {fmtDateTime(completionAct.signedAt)}
                </p>
              )}
              {completionAct.status === 'DRAFT' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => signAct(completionAct.id)}
                  loading={signingAct}
                >
                  Позначити як підписано
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadActPdf(completionAct.id)}
                loading={downloadingActPdf}
              >
                PDF акту
              </Button>
              {completionAct.status === 'DRAFT' && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => cancelAct(completionAct.id)}
                  loading={cancellingAct}
                  disabled={cancellingAct}
                >
                  Скасувати акт
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Акт не сформовано</p>
          )}
        </div>
      )}

      {/* Invoice slot. Bug #510: винесено у InvoiceSection для component-test. */}
      {/* E3: money-секція під error-boundary — краш рахунку не валить усю картку наряду. */}
      <SectionErrorBoundary label="Рахунок">
        <InvoiceSection
          workOrderId={id}
          workOrderStatus={wo.status}
          invoiceRef={invoiceRef}
          onChange={setInvoiceRef}
        />
      </SectionErrorBoundary>

      {/* Гарантії наряду (by-work-order + claim + ручний create). Гейт за статусом усередині секції. */}
      <SectionErrorBoundary label="Гарантії">
        <WarrantySection
          workOrderId={id}
          counterpartyId={wo.counterpartyId}
          workOrderStatus={wo.status}
        />
      </SectionErrorBoundary>

      <WorkOrderLinesSection
        woId={id}
        orgId={wo.orgId}
        lines={wo.lines}
        works={works}
        employees={employees}
        onChanged={load}
        disabled={!canEdit}
        onError={setError}
      />

      <WorkOrderPartsSection
        woId={id}
        parts={wo.parts}
        warehouses={warehouses}
        initialWarehouseId={initialPartWarehouseId}
        onChanged={load}
        disabled={!canEdit}
        onError={setError}
      />

      {/* Inspection section */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-secondary flex items-center justify-between">
          <h3 className="font-semibold text-foreground text-sm">Огляд авто</h3>
          {!inspection && (
            <Button variant="outline" size="sm" onClick={() => setShowInspection(v => !v)}>
              {showInspection ? 'Згорнути' : 'Провести огляд'}
            </Button>
          )}
        </div>

        {inspection ? (
          <div className="p-4 space-y-2">
            <div className="text-[12px] text-muted-foreground mb-3">
              {fmtDateTime(inspection.createdAt)}
              {inspection.mileage != null && ` · ${fmtInt(inspection.mileage)} км`}
            </div>
            {inspection.points.map((p, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    'w-2 h-2 rounded-full shrink-0',
                    p.status === 'OK'
                      ? 'bg-success'
                      : p.status === 'WARN'
                        ? 'bg-warning'
                        : 'bg-destructive',
                  )}
                />
                <span className="flex-1 text-foreground">{p.name}</span>
                <span className="text-muted-foreground">
                  {p.value}
                  {p.unit ? ' ' + p.unit : ''}
                </span>
                {p.status === 'CRITICAL' && (
                  <span className="text-[11px] text-destructive-text bg-destructive-subtle px-1.5 py-0.5 rounded">
                    Критично
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : showInspection ? (
          <AnimatedBody className="p-4 space-y-3">
            <Input
              label="Пробіг (км)"
              type="number"
              value={inspMileage}
              onChange={e => setInspMileage(e.target.value)}
              placeholder="Поточний пробіг"
              className="h-8 text-[13px]"
            />
            <div className="space-y-2">
              {inspectionPoints.map((point, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-4 text-[13px] text-foreground">{point.name}</div>
                  <div className="col-span-3">
                    <Input
                      value={point.value}
                      onChange={e => {
                        const pts = [...inspectionPoints];
                        pts[i] = { ...pts[i], value: e.target.value };
                        setInspectionPoints(pts);
                      }}
                      placeholder={point.unit || 'значення'}
                      className="h-8 text-[13px]"
                    />
                  </div>
                  <div className="col-span-5">
                    <select
                      value={point.status}
                      onChange={e => {
                        const pts = [...inspectionPoints];
                        pts[i] = {
                          ...pts[i],
                          status: e.target.value as 'OK' | 'WARN' | 'CRITICAL',
                        };
                        setInspectionPoints(pts);
                      }}
                      className="w-full h-8 rounded-lg border border-border bg-input px-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="OK">✓ OK</option>
                      <option value="WARN">⚠ Увага</option>
                      <option value="CRITICAL">✗ Критично</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
            <Button
              onClick={() => void saveInspection()}
              loading={savingInspection}
              className="w-full"
            >
              Зберегти огляд
            </Button>
          </AnimatedBody>
        ) : (
          <div className="p-4 text-center text-muted-foreground text-[13px]">
            Огляд не проводився
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <h2 className="font-semibold text-foreground mb-4">Коментарі</h2>
        {comments.length > 0 && (
          <div className="space-y-3 mb-4">
            {comments.map(c => (
              <div key={c.id} className="flex gap-3">
                <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-[11px] font-semibold text-primary">
                    {c.authorName ? c.authorName[0] : '?'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[12px] font-medium text-foreground">
                      {c.authorName ?? 'Невідомо'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtShortDateTime(c.createdAt)}
                    </span>
                  </div>
                  <p className="text-[13px] text-foreground whitespace-pre-wrap wrap-break-word">
                    {c.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
        {comments.length === 0 && (
          <p className="text-sm text-muted-foreground mb-4">Коментарів немає</p>
        )}
        {employee && (
          <div className="flex gap-2">
            <textarea
              value={commentBody}
              onChange={e => setCommentBody(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  void submitComment();
                }
              }}
              placeholder="Напишіть коментар... (Ctrl+Enter для відправки)"
              rows={2}
              className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
            <Button
              size="sm"
              onClick={() => void submitComment()}
              loading={commentSaving}
              disabled={!commentBody.trim()}
              className="self-end"
            >
              Надіслати
            </Button>
          </div>
        )}
      </div>

      {/* E3: медіа-секція під error-boundary — краш рендеру медіа не валить картку наряду. */}
      <SectionErrorBoundary label="Медіа наряду">
        <WorkOrderMediaSection woId={id} media={media} onChanged={loadMedia} onError={setError} />
      </SectionErrorBoundary>

      <WorkOrderAuditSection auditEvents={auditEvents} />

      <ConfirmDialog {...dialogProps} />

      {/* ── Редагування реквізитів ─────────────────────────────────────────── */}
      <Modal
        open={editModal}
        onClose={() => setEditModal(false)}
        title="Редагування реквізитів"
        size="md"
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="outline" onClick={() => setEditModal(false)}>
              Скасувати
            </Button>
            <Button onClick={saveEdit} loading={editSaving}>
              Зберегти
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">
              Дата документа
            </label>
            <DatePickerInput
              value={editForm.documentDate}
              onChange={v => setEditForm(f => ({ ...f, documentDate: v }))}
              placeholder="ДД.ММ.РРРР"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">Пріоритет</label>
            <Select
              value={editForm.priority}
              onChange={e => setEditForm(f => ({ ...f, priority: e.target.value }))}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              <option value="LOW">Низький</option>
              <option value="NORMAL">Звичайний</option>
              <option value="HIGH">Високий</option>
              <option value="URGENT">Терміново</option>
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">
              Категорія ремонту
            </label>
            <Select
              value={editForm.repairCategory}
              onChange={e => setEditForm(f => ({ ...f, repairCategory: e.target.value }))}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              <option value="">— не вказано —</option>
              <option value="MAINTENANCE">ТО</option>
              <option value="CURRENT_REPAIR">Поточний ремонт</option>
              <option value="MAJOR_REPAIR">Кап. ремонт</option>
              <option value="BODY_REPAIR">Кузовний</option>
              <option value="DIAGNOSTICS">Діагностика</option>
              <option value="WARRANTY">Гарантійний</option>
              <option value="SEASONAL">Сезонне</option>
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">Дедлайн</label>
            <DatePickerInput
              value={editForm.dueDate}
              onChange={v => setEditForm(f => ({ ...f, dueDate: v }))}
              placeholder="ДД.ММ.РРРР"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">
              Пробіг (вхід), км
            </label>
            <Input
              type="number"
              min={0}
              value={editForm.inMileage}
              onChange={e => setEditForm(f => ({ ...f, inMileage: e.target.value }))}
              placeholder="0"
              className="h-8 text-[13px]"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer text-[13px] font-medium text-foreground">
              <input
                type="checkbox"
                checked={editForm.clientApproval}
                onChange={e => setEditForm(f => ({ ...f, clientApproval: e.target.checked }))}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Погодження клієнта
            </label>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">Опис</label>
            <textarea
              value={editForm.description}
              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              placeholder="Опис робіт..."
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
