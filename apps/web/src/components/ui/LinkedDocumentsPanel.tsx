'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  ElementType,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import { X, ExternalLink, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// ─── Generic config-driven API ────────────────────────────
//
// Раніше панель була жорстко прив'язана до наряду (WorkOrder). Тепер вона
// config-driven: кожна сутність (наряд, рахунок, замовлення, оплата, контрагент…)
// постачає `LinkedEntityConfig` зі своїм fetch-URL і набором секцій; кожен рядок
// секції мапиться у `LinkedSectionItem` з опційною навігацією `navigate?()`.
// Спільні примітиви (DocSection/SectionRow/PreviewPopup) лишились незмінними.

/** Один рядок у секції пов'язаних документів. */
export interface LinkedSectionItem {
  id: string;
  primary: string;
  secondary?: string;
  badge?: { label: string; className: string };
  /** Вміст прев'ю-попапа (key/value рядки). */
  preview: { title: string; rows: Array<{ label: string; value: ReactNode }> };
  /** Перехід до документа (deep-link). undefined → кнопки «Відкрити» немає. */
  navigate?: () => void;
}

/** Опис однієї секції: як її назвати, якою іконкою і як мапити рядки відповіді. */
export interface LinkedSectionConfig {
  /** Ключ секції — збігається з ключем у відповіді backend та у counts-мапі. */
  key: string;
  title: string;
  icon: ElementType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapRow: (row: any) => LinkedSectionItem;
}

/** Конфіг сутності: звідки тягнути linked-documents і які секції рендерити. */
export interface LinkedEntityConfig {
  /** Напр. (id) => `/invoices/${id}/linked-documents`. */
  fetchPath: (entityId: string) => string;
  sections: LinkedSectionConfig[];
}

/** Кількість елементів у кожній секції (для badge-лічильників списку/вкладки). */
export type LinkedDocumentsCounts = Record<string, number>;

/** Форма відповіді backend: { [sectionKey]: Row[] }. */
type LinkedDocumentsResponse = Record<string, unknown[]>;

// ─── Preview Popup ─────────────────────────────────────────

function PreviewPopup({
  item,
  anchorRef,
  onClose,
}: {
  item: LinkedSectionItem;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });

  // useLayoutEffect — synchronous DOM measurement to avoid flash at (0,0) before reposition.
  // Включаємо `item` у deps: коли користувач відкриває preview іншого рядка без
  // попереднього закриття, anchorRef.current змінюється — компонент перепозиціонується.
  // Тільки [anchorRef] (стабільний ref) → ефект ніколи не перезапускався → попап
  // залишався у позиції першого відкритого рядка (IMPORTANT bug).
  useLayoutEffect(() => {
    if (!anchorRef.current || !popupRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popupH = popupRef.current.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow > popupH + 8 ? rect.bottom + 8 : rect.top - popupH - 8;
    const left = Math.min(rect.left, window.innerWidth - 320 - 16);
    setStyle({ top, left: Math.max(8, left), opacity: 1 });
  }, [anchorRef, item]);

  // Capture + stopImmediatePropagation: PreviewPopup може рендеритися всередині
  // батьківського <Modal> (напр. вкладка «Документи»), який теж слухає Esc на document.
  // Без capture-фази Esc закрив би одразу і preview, і весь модал.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-69" onClick={onClose} />
      <div
        ref={popupRef}
        style={{ ...style, position: 'fixed', width: 300, zIndex: 70 }}
        className="bg-surface border border-border rounded-xl shadow-xl p-4 text-[13px]"
        role="dialog"
        aria-modal="true"
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
          aria-label="Закрити"
        >
          <X size={14} />
        </button>

        <div className="font-semibold mb-3 pr-5">{item.preview.title}</div>
        <div className="space-y-0">
          {item.preview.rows.map((r, i) => (
            <PreviewRow key={i} label={r.label} value={r.value} />
          ))}
        </div>
        {item.navigate && (
          <button
            onClick={() => {
              item.navigate?.();
              onClose();
            }}
            className="mt-4 flex items-center gap-1.5 text-primary hover:underline text-[12px] font-medium"
          >
            <ExternalLink size={13} />
            Відкрити
          </button>
        )}
      </div>
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 py-1 border-b border-border last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────

function DocSection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: ElementType;
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-secondary flex items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <h3 className="font-medium text-foreground text-sm">
          {title} <span className="text-muted-foreground font-normal">({count})</span>
        </h3>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function SectionRow({
  icon: Icon,
  primary,
  secondary,
  badge,
  onClick,
}: {
  icon: ElementType;
  primary: string;
  secondary?: string;
  badge?: { label: string; className: string };
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-secondary/60 transition-colors text-left text-[13px]"
    >
      <Icon size={15} className="text-muted-foreground shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="font-medium text-foreground">{primary}</span>
        {secondary && (
          <span className="block text-[11px] text-muted-foreground truncate">{secondary}</span>
        )}
      </span>
      {badge && (
        <span className={cn('px-2 py-0.5 rounded-full text-[11px] shrink-0', badge.className)}>
          {badge.label}
        </span>
      )}
    </button>
  );
}

// ─── Main Component ────────────────────────────────────────

export function LinkedDocumentsPanel({
  config,
  entityId,
  refreshKey,
  onLoad,
}: {
  config: LinkedEntityConfig;
  entityId: string;
  // parent інкрементує key після створення/refresh пов'язаного документу
  // → useEffect deps тригерять fetch без unmount/remount, стале UI не показується.
  refreshKey?: number;
  onLoad?: (counts: LinkedDocumentsCounts) => void;
}) {
  // Мапимо сирі рядки у section→items[] один раз після завантаження.
  const [sections, setSections] = useState<Array<{
    key: string;
    title: string;
    icon: ElementType;
    items: LinkedSectionItem[];
  }> | null>(null);
  const [loading, setLoading] = useState(true);
  // окремий error-state, інакше backend помилку 500/timeout не відрізнити
  // від справжнього empty-state ("Пов'язаних документів немає") — користувач отримує
  // false reassurance.
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [preview, setPreview] = useState<LinkedSectionItem | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  // config зазвичай module-level constant (стабільний), але тримаємо у ref, щоб
  // fetch-ефект залежав лише від entityId/refreshKey (як раніше), а не від identity config.
  const configRef = useRef(config);
  configRef.current = config;
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    // Race-guard: користувач швидко перемикає entityId → стара відповідь не має
    // перезаписувати стан від нового запиту (§3.1).
    let cancelled = false;
    const cfg = configRef.current;
    setLoading(true);
    setError(null);
    setPreview(null);
    apiFetch<LinkedDocumentsResponse>(cfg.fetchPath(entityId))
      .then(d => {
        if (cancelled) return;
        const mapped = cfg.sections.map(s => {
          const rows = Array.isArray(d[s.key]) ? d[s.key] : [];
          return { key: s.key, title: s.title, icon: s.icon, items: rows.map(s.mapRow) };
        });
        setSections(mapped);
        setError(null);
        const counts: LinkedDocumentsCounts = {};
        for (const s of mapped) counts[s.key] = s.items.length;
        onLoadRef.current?.(counts);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          // не «приховувати» error під empty-state. Залишаємо sections null —
          // render-логіка покаже банер з повідомленням і Retry-кнопкою.
          setSections(null);
          setError(e instanceof Error ? e.message : 'Не вдалось завантажити пов’язані документи');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, refreshKey, retryKey]);

  const openPreview = (e: ReactMouseEvent<HTMLButtonElement>, item: LinkedSectionItem) => {
    anchorRef.current = e.currentTarget;
    setPreview(item);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Завантаження…
      </div>
    );
  }

  // error має пріоритет над null/empty data — інакше панель «приховала» помилку.
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center py-8 px-4 gap-3 text-sm text-muted-foreground"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle size={16} aria-hidden="true" />
          <span className="font-medium">Не вдалось завантажити пов’язані документи</span>
        </div>
        <p className="text-xs text-center max-w-xs">{error}</p>
        <button
          type="button"
          onClick={() => setRetryKey(k => k + 1)}
          className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          Спробувати ще раз
        </button>
      </div>
    );
  }

  if (!sections) return null;

  const total = sections.reduce((sum, s) => sum + s.items.length, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Пов'язаних документів немає
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {sections.map(section => (
          <DocSection
            key={section.key}
            icon={section.icon}
            title={section.title}
            count={section.items.length}
          >
            {section.items.map(item => (
              <SectionRow
                key={item.id}
                icon={section.icon}
                primary={item.primary}
                secondary={item.secondary}
                badge={item.badge}
                onClick={e => openPreview(e, item)}
              />
            ))}
          </DocSection>
        ))}
      </div>

      {preview && (
        <PreviewPopup item={preview} anchorRef={anchorRef} onClose={() => setPreview(null)} />
      )}
    </>
  );
}
