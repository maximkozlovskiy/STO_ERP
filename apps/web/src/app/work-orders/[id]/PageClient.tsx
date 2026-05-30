'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch, apiBlobFetch, apiMultipartFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { SearchCombobox, type ComboboxItem } from '@/components/ui/search-combobox';
import { Spinner } from '@/components/ui/spinner';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { BatchViewerModal } from '@/components/ui/batch-viewer-modal';
import { Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtInt, fmtDate, fmtDateTime, fmtShortDateTime } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { toast } from '@/lib/toast';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkOrderMedia {
  // Bug #93: `fileKey` removed — backend no longer leaks the internal MinIO path.
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
}
interface WorkOrderPart {
  id: string;
  goodId: string;
  goodName?: string;
  unitShortName?: string;
  coefficient?: number;
  warehouseId: string;
  quantity: number;
  price: number;
  amount: number;
}
interface WorkOrderDetail {
  id: string;
  number: string;
  status: string;
  branchId: string;
  branchName?: string;
  vehicleId: string;
  vehicleSummary?: string;
  counterpartyId: string;
  counterpartyName?: string;
  description?: string | null;
  inMileage?: number | null;
  outMileage?: number | null;
  plannedAt?: string | null;
  completedAt?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  repairCategory?: string | null;
  clientApproval?: boolean | null;
  totalLabor: number;
  totalParts: number;
  totalAmount: number;
  paidAmount: number;
  lines: WorkOrderLine[];
  parts: WorkOrderPart[];
}

interface Comment {
  id: string;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt: string;
}

interface CompletionActSummary {
  id: string;
  number: string;
  status: 'DRAFT' | 'SIGNED' | 'CANCELLED';
  signedAt?: string | null;
  signedBy?: string | null;
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

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD: 'Призупинено',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставлено',
  PAID: 'Оплачено',
  ARCHIVED: 'Архів',
  CANCELLED: 'Скасовано',
};
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
  const [works, setWorks] = useState<Work[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [completionAct, setCompletionAct] = useState<CompletionActSummary | null>(null);
  const [generatingAct, setGeneratingAct] = useState(false);
  const [signingAct, setSigningAct] = useState(false);
  const [downloadingActPdf, setDownloadingActPdf] = useState(false);

  const [lineModal, setLineModal] = useState(false);
  const [partModal, setPartModal] = useState(false);
  const [batchViewer, setBatchViewer] = useState<{ goodId: string; warehouseId: string } | null>(
    null,
  );
  const [transitioning, setTransitioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);
  const [deletingPartId, setDeletingPartId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refsError, setRefsError] = useState('');

  const [lineForm, setLineForm] = useState({
    workId: '',
    employeeId: '',
    normoHours: '',
    actualHours: '',
    price: '',
    notes: '',
  });
  const [partForm, setPartForm] = useState({
    goodId: '',
    warehouseId: '',
    quantity: '1',
    price: '',
  });
  const [goodDisplayName, setGoodDisplayName] = useState('');
  const [stockAvailable, setStockAvailable] = useState<number | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

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
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>([]);

  const [savingTemplate, setSavingTemplate] = useState(false);

  const features = useUiFeatures();
  const lineDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const partDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!features.stockIndicatorEnabled || !partForm.goodId || !partForm.warehouseId) {
      setStockAvailable(null);
      return;
    }
    let cancelled = false;
    setStockLoading(true);
    apiFetch<{ items: { available: number }[] }>(
      `/stock-items?goodId=${partForm.goodId}&warehouseId=${partForm.warehouseId}&limit=1`,
    )
      .then(r => {
        if (cancelled) return;
        setStockAvailable(r.items[0]?.available ?? 0);
      })
      .catch(() => {
        if (!cancelled) setStockAvailable(null);
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [features.stockIndicatorEnabled, partForm.goodId, partForm.warehouseId]);

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
    ]).then(([woResult, acts, inspectionData]) => {
      if (!mountedRef.current) return;
      if (woResult.kind === 'wo') {
        setWo(woResult.data);
      } else {
        setError(
          woResult.error instanceof Error ? woResult.error.message : 'Помилка завантаження наряду',
        );
      }
      if (acts.items.length > 0) setCompletionAct(acts.items[0]);
      setInspection(inspectionData);
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
      .catch(() => {});
  }, [id]);

  const loadMedia = useCallback(() => {
    apiFetch<{ items: WorkOrderMedia[] }>(`/work-orders/${id}/media`)
      .then(d => {
        if (mountedRef.current) setMedia(d.items ?? []);
      })
      .catch(() => {});
  }, [id]);

  // Bug #89: Escape closes lightbox + a11y. Without this keyboard users can't
  // dismiss the photo preview at all.
  useEffect(() => {
    if (!lightboxUrl) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxUrl(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lightboxUrl]);

  const handleMediaUpload = async (files: FileList) => {
    setUploadingMedia(true);
    setError('');
    // Bug #85: використовуємо apiMultipartFetch для silent refresh при 401.
    // Раніше native fetch з прямим Bearer ламався після того як access token закінчувався (~15 хв)
    // і користувач отримував абстрактне "Не вдалося завантажити N файл(ів)" без auto-recovery.
    //
    // Parallel upload — each file is an independent multipart POST. With 5+ files
    // sequential waits stack into seconds; Promise.allSettled keeps individual
    // failure tracking intact while collapsing wall-clock time to max(file).
    const results = await Promise.allSettled(
      Array.from(files).map(file => {
        const fd = new FormData();
        fd.append('file', file);
        return apiMultipartFetch(`/work-orders/${id}/media`, fd);
      }),
    );
    const failures = results.filter(r => r.status === 'rejected').length;
    if (failures > 0) {
      setError(`Не вдалося завантажити ${failures} файл(ів)`);
    }
    await loadMedia();
    setUploadingMedia(false);
  };

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
      if (mainW) setPartForm(f => (f.warehouseId ? f : { ...f, warehouseId: mainW.id }));
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
        if (mainW) setPartForm(f => (f.warehouseId ? f : { ...f, warehouseId: mainW.id }));
      })
      .catch((e: unknown) => {
        if (mountedRef.current && !cachedWarehouses)
          setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });
    apiFetch<InspectionPoint[]>(`/work-orders/${id}/inspection/default-points`)
      .then(d => {
        if (mountedRef.current) setInspectionPoints(d);
      })
      .catch(() => {});
  }, [id]);

  const selectWork = (workId: string) => {
    const w = works.find(x => x.id === workId);
    setLineForm(f => ({
      ...f,
      workId,
      normoHours: w ? String(w.normoHours) : f.normoHours,
      price: w ? String(w.price) : f.price,
    }));
    lineDirty.markDirty();
  };

  const selectGood = (item: Good) => {
    setGoodDisplayName(item.name);
    setPartForm(f => ({
      ...f,
      goodId: item.id,
      price: item.salePrice ? String(item.salePrice) : f.price,
    }));
    partDirty.markDirty();
  };

  const closeLineModal = async () => {
    if (!(await lineDirty.confirmClose())) return;
    setLineModal(false);
    lineDirty.resetDirty();
  };

  const closePartModal = async () => {
    if (!(await partDirty.confirmClose())) return;
    setPartModal(false);
    setGoodDisplayName('');
    partDirty.resetDirty();
  };

  const addLine = async () => {
    setSaving(true);
    setError('');
    try {
      await apiFetch<WorkOrderLine>(`/work-orders/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          workId: lineForm.workId,
          employeeId: lineForm.employeeId,
          normoHours: lineForm.normoHours ? Number(lineForm.normoHours) : undefined,
          actualHours: lineForm.actualHours ? Number(lineForm.actualHours) : undefined,
          price: lineForm.price ? Number(lineForm.price) : undefined,
          notes: lineForm.notes || undefined,
        }),
      });
      setLineModal(false);
      setLineForm({
        workId: '',
        employeeId: '',
        normoHours: '',
        actualHours: '',
        price: '',
        notes: '',
      });
      lineDirty.resetDirty();
      if (features.toastEnabled) toast.success('Роботу додано');
      load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const removeLine = async (lineId: string) => {
    if (!(await confirm({ title: 'Видалити роботу?', variant: 'destructive' }))) return;
    setDeletingLineId(lineId);
    setError('');
    try {
      await apiFetch<void>(`/work-orders/${id}/lines/${lineId}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success('Роботу видалено');
      load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка видалення';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setDeletingLineId(null);
    }
  };

  const addPart = async () => {
    setSaving(true);
    setError('');
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
      // Preserve `warehouseId` so the auto-selected main warehouse stays put
      // across consecutive part additions. The auto-select useEffect runs
      // only on mount; without this, MECHANIC adding 3-5 parts would have
      // to re-pick the same warehouse every time — defeating the feature.
      setPartForm(f => ({ goodId: '', warehouseId: f.warehouseId, quantity: '1', price: '' }));
      setGoodDisplayName('');
      partDirty.resetDirty();
      if (features.toastEnabled) toast.success('Запчастину додано');
      load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const removePart = async (partId: string) => {
    if (!(await confirm({ title: 'Видалити запчастину?', variant: 'destructive' }))) return;
    setDeletingPartId(partId);
    setError('');
    try {
      await apiFetch<void>(`/work-orders/${id}/parts/${partId}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success('Запчастину видалено');
      load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка видалення';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setDeletingPartId(null);
    }
  };

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

  const downloadPdf = async () => {
    // Bug #77: use apiBlobFetch which does silent refresh on 401 — direct fetch
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
      // Bug #77: same silent-refresh hardening as downloadPdf above.
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
        ) : (
          <Spinner size="lg" />
        )}
      </div>
    );

  const canEdit = ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(wo.status);
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
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-3 text-sm">
        {wo.branchName && (
          <div>
            <p className="text-xs text-muted-foreground">Філія</p>
            <p className="text-foreground">{wo.branchName}</p>
          </div>
        )}
        {wo.priority && (
          <div>
            <p className="text-xs text-muted-foreground">Пріоритет</p>
            <p className="text-foreground">{wo.priority}</p>
          </div>
        )}
        {wo.repairCategory && (
          <div>
            <p className="text-xs text-muted-foreground">Категорія ремонту</p>
            <p className="text-foreground">{wo.repairCategory}</p>
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
            <p className="text-foreground">{wo.clientApproval ? 'Так' : 'Ні'}</p>
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
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-3 gap-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Роботи</p>
          <p className="text-lg font-semibold text-foreground">{fmtMoney(wo.totalLabor)} ₴</p>
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
          {canEdit && (
            <button
              onClick={() => {
                setError('');
                setLineModal(true);
              }}
              className="text-sm text-primary hover:underline"
            >
              + Робота
            </button>
          )}
        </div>
        {wo.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Роботи не додані</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {wo.lines.map(l => (
              <div key={l.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{l.workName}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.employeeName} · <span>{l.normoHours} н/г норм.</span>
                    {l.actualHours != null && (
                      <span
                        className={cn(
                          'ml-1',
                          l.actualHours > l.normoHours
                            ? 'text-warning font-medium'
                            : 'text-muted-foreground/70',
                        )}
                      >
                        {l.actualHours} н/г факт.
                      </span>
                    )}
                  </p>
                  {l.notes && <p className="text-xs text-muted-foreground mt-0.5">{l.notes}</p>}
                </div>
                <div className="text-right mr-3">
                  <p className="text-sm font-medium text-foreground">{fmtMoney(l.amount)} ₴</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtMoney(l.price)} × {l.normoHours}
                  </p>
                </div>
                {canEdit && (
                  <button
                    onClick={() => removeLine(l.id)}
                    disabled={deletingLineId === l.id}
                    className="text-xs text-destructive/60 hover:text-destructive px-1 disabled:opacity-50"
                  >
                    ×
                  </button>
                )}
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
              <button
                onClick={() => {
                  setError('');
                  setPartModal(true);
                }}
                className="text-sm text-primary hover:underline"
              >
                + Запчастина
              </button>
            </div>
          )}
        </div>
        {wo.parts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Запчастини не додані</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {wo.parts.map(p => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-foreground">{p.goodName}</p>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        setBatchViewer({ goodId: p.goodId, warehouseId: p.warehouseId });
                      }}
                      title="Переглянути партії"
                      aria-label={`Переглянути партії товару ${p.goodName}`}
                      className="p-0.5 rounded text-muted-foreground/50 hover:text-primary hover:bg-primary/10 transition-colors"
                    >
                      <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.quantity} {p.unitShortName ?? 'шт'} × {fmtMoney(p.price)} ₴
                  </p>
                </div>
                <div className="text-right mr-3">
                  <p className="text-sm font-medium text-foreground">{fmtMoney(p.amount)} ₴</p>
                </div>
                {canEdit && (
                  <button
                    onClick={() => removePart(p.id)}
                    disabled={deletingPartId === p.id}
                    className="text-xs text-destructive/60 hover:text-destructive px-1 disabled:opacity-50"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

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
                      className="w-full h-9 rounded-lg border border-border bg-input px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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

      {/* Фото */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-secondary flex items-center justify-between">
          <h3 className="font-medium text-foreground text-sm">Фото ({media.length})</h3>
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={e => {
                if (e.target.files) void handleMediaUpload(e.target.files);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              loading={uploadingMedia}
              onClick={e => e.preventDefault()}
            >
              Додати фото
            </Button>
          </label>
        </div>
        <div
          className="p-4"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            void handleMediaUpload(e.dataTransfer.files);
          }}
        >
          {media.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-6 border-2 border-dashed border-border rounded-lg">
              Перетягніть фото сюди або натисніть &quot;Додати фото&quot;
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {media.map(m => (
                <div
                  key={m.id}
                  className="relative group aspect-square rounded-lg overflow-hidden bg-secondary cursor-pointer"
                  onClick={() => setLightboxUrl(m.signedUrl)}
                >
                  {m.mimeType.startsWith('image/') ? (
                    <img
                      src={m.signedUrl}
                      alt={m.filename}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground p-1 text-center break-all">
                      {m.filename}
                    </div>
                  )}
                  <button
                    onClick={async e => {
                      e.stopPropagation();
                      await apiFetch(`/work-orders/${id}/media/${m.id}`, { method: 'DELETE' });
                      setMedia(prev => prev.filter(x => x.id !== m.id));
                    }}
                    className="absolute top-1 right-1 hidden group-hover:flex w-6 h-6 bg-destructive text-white rounded-full items-center justify-center text-xs"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox — Bug #89: a11y (role/aria-modal/aria-label) + Escape handled in useEffect above */}
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Перегляд фото"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Фото"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            decoding="async"
          />
        </div>
      )}

      {/* Журнал змін */}
      {auditEvents.length > 0 && (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-secondary">
            <h3 className="font-medium text-foreground text-sm">Журнал змін</h3>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {auditEvents.map(ev => {
              const who = `${ev.user.lastName} ${ev.user.firstName}`;
              const when = fmtDateTime(ev.createdAt);
              const diff = ev.diff as Record<string, { from: unknown; to: unknown }>;
              const changes = Object.entries(diff)
                .filter(([, v]) => v && typeof v === 'object' && 'from' in v)
                .map(
                  ([k, v]) =>
                    `${k}: ${(v as { from: unknown; to: unknown }).from} → ${(v as { from: unknown; to: unknown }).to}`,
                )
                .join(', ');
              return (
                <div key={ev.id} className="px-5 py-2.5 text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground">{who}</span>{' '}
                  {ev.action === 'CREATE'
                    ? 'створив'
                    : ev.action === 'DELETE'
                      ? 'видалив'
                      : 'змінив'}{' '}
                  {changes && <span className="text-foreground-muted">({changes})</span>}{' '}
                  <span className="ml-1">{when}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Line Modal */}
      <Modal open={lineModal} onClose={closeLineModal} title="Додати роботу">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Робота <span className="text-destructive">*</span>
            </label>
            <Select value={lineForm.workId} onChange={e => selectWork(e.target.value)}>
              <option value="">— Оберіть —</option>
              {works.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Виконавець <span className="text-destructive">*</span>
            </label>
            <Select
              value={lineForm.employeeId}
              onChange={e => {
                setLineForm(f => ({ ...f, employeeId: e.target.value }));
                lineDirty.markDirty();
              }}
            >
              <option value="">— Оберіть —</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.lastName} {e.firstName}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Нормо-год (план)
              </label>
              <Input
                type="number"
                value={lineForm.normoHours}
                onChange={e => {
                  setLineForm(f => ({ ...f, normoHours: e.target.value }));
                  lineDirty.markDirty();
                }}
                min="0"
                step="0.1"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Факт. год
              </label>
              <Input
                type="number"
                value={lineForm.actualHours}
                onChange={e => {
                  setLineForm(f => ({ ...f, actualHours: e.target.value }));
                  lineDirty.markDirty();
                }}
                min="0"
                step="0.1"
                placeholder="необов'язково"
              />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна, ₴</label>
            <Input
              type="number"
              value={lineForm.price}
              onChange={e => {
                setLineForm(f => ({ ...f, price: e.target.value }));
                lineDirty.markDirty();
              }}
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Нотатки</label>
            <Input
              value={lineForm.notes}
              onChange={e => {
                setLineForm(f => ({ ...f, notes: e.target.value }));
                lineDirty.markDirty();
              }}
            />
          </div>
          <Button
            onClick={addLine}
            loading={saving}
            disabled={!lineForm.workId || !lineForm.employeeId}
            className="w-full"
          >
            Додати
          </Button>
        </div>
      </Modal>

      {/* Batch Viewer Modal */}
      {batchViewer && (
        <BatchViewerModal
          goodId={batchViewer.goodId}
          warehouseId={batchViewer.warehouseId}
          open={!!batchViewer}
          onClose={() => setBatchViewer(null)}
        />
      )}

      {/* Add Part Modal */}
      <Modal open={partModal} onClose={closePartModal} title="Додати запчастину">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <SearchCombobox<Good>
            label="Товар"
            required
            placeholder="Назва, артикул, штрих-код..."
            value={partForm.goodId}
            displayValue={goodDisplayName}
            onSelect={selectGood}
            onClear={() => {
              setPartForm(f => ({ ...f, goodId: '', price: '' }));
              setGoodDisplayName('');
              partDirty.markDirty();
            }}
            fetchItems={q =>
              apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=10`).then(r =>
                r.items.map(g => ({ ...g, primary: g.name, secondary: g.sku })),
              )
            }
          />
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Склад <span className="text-destructive">*</span>
            </label>
            <Select
              value={partForm.warehouseId}
              onChange={e => {
                setPartForm(f => ({ ...f, warehouseId: e.target.value }));
                partDirty.markDirty();
              }}
            >
              <option value="">— Оберіть —</option>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            {features.stockIndicatorEnabled && partForm.goodId && partForm.warehouseId && (
              <p
                className={cn(
                  'mt-1.5 text-[12px]',
                  stockLoading
                    ? 'text-muted-foreground'
                    : stockAvailable === null
                      ? 'text-muted-foreground'
                      : stockAvailable > 0
                        ? 'text-success'
                        : 'text-destructive',
                )}
              >
                {stockLoading
                  ? 'Перевірка залишку...'
                  : stockAvailable === null
                    ? ''
                    : stockAvailable > 0
                      ? `Доступно: ${stockAvailable} шт.`
                      : 'Немає в наявності'}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Кількість <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                value={partForm.quantity}
                onChange={e => {
                  setPartForm(f => ({ ...f, quantity: e.target.value }));
                  partDirty.markDirty();
                }}
                min="0.001"
                step="0.001"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Ціна, ₴
              </label>
              <Input
                type="number"
                value={partForm.price}
                onChange={e => {
                  setPartForm(f => ({ ...f, price: e.target.value }));
                  partDirty.markDirty();
                }}
              />
            </div>
          </div>
          <Button
            onClick={addPart}
            loading={saving}
            disabled={
              !partForm.goodId ||
              !partForm.warehouseId ||
              !partForm.quantity ||
              (features.stockIndicatorEnabled &&
                stockAvailable !== null &&
                stockAvailable < Number(partForm.quantity))
            }
            className="w-full"
          >
            Додати
          </Button>
        </div>
      </Modal>
      <DirtyConfirmDialog {...lineDirty.dialogProps} />
      <DirtyConfirmDialog {...partDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
