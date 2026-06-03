'use client';

import { type ReactNode, useState, useEffect, useRef } from 'react';
import { X, Settings, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

export interface DetailPanelTab {
  key: string;
  label: string;
  content: ReactNode;
}

export interface PanelConfigField {
  key: string;
  label: string;
  hidden: boolean;
  always?: boolean;
}

interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  tabs?: DetailPanelTab[];
  children?: ReactNode;
  defaultTab?: string;
  configFields?: PanelConfigField[];
  onToggleField?: (fieldKey: string) => void;
  /** Called when user drags to reorder fields — receives new ordered keys */
  onReorderFields?: (newOrder: string[]) => void;
  onReset?: () => void;
}

export function DetailPanel({
  open,
  onClose,
  title,
  subtitle,
  tabs,
  children,
  defaultTab,
  configFields,
  onToggleField,
  onReorderFields,
  onReset,
}: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState(defaultTab ?? tabs?.[0]?.key ?? '');
  const [showConfig, setShowConfig] = useState(false);
  const { state: contentState } = useAnimatedPresence(open, 150);
  // Local drag state — dragged key and drop target key
  const dragKeyRef = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  useEffect(() => {
    if (defaultTab) setActiveTab(defaultTab);
    else if (tabs?.[0]) setActiveTab(tabs[0].key);
    setShowConfig(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const activeContent = tabs?.find(t => t.key === activeTab)?.content ?? children;
  const hasConfig = configFields && configFields.length > 0 && onToggleField;

  return (
    <div
      className={cn(
        'flex flex-col shrink-0 bg-surface transition-[width,margin] duration-200 overflow-hidden rounded-xl border border-border',
        open ? 'w-64 ml-2' : 'w-0 ml-0 border-transparent',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-baseline gap-1 overflow-hidden">
            <h2 className="text-[13px] font-semibold text-foreground leading-tight truncate min-w-0">
              {title}
            </h2>
            {subtitle && <span className="text-[11px] text-muted-foreground shrink-0">·</span>}
            {subtitle && (
              <span className="text-[11px] text-muted-foreground truncate min-w-0">{subtitle}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {hasConfig && (
            <button
              type="button"
              onClick={() => setShowConfig(s => !s)}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded transition-colors',
                showConfig
                  ? 'text-primary bg-secondary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
              )}
              title="Налаштування панелі"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Закрити"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showConfig && hasConfig ? (
        /* Config panel */
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">
              Поля панелі
            </span>
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Скинути
            </button>
          </div>
          <div className="space-y-0.5">
            {configFields.map(field => (
              <div
                key={field.key}
                draggable={!field.always && !!onReorderFields}
                onDragStart={() => {
                  dragKeyRef.current = field.key;
                }}
                onDragOver={e => {
                  e.preventDefault();
                  setDragOverKey(field.key);
                }}
                onDragLeave={() => setDragOverKey(null)}
                onDrop={() => {
                  setDragOverKey(null);
                  const from = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (!from || from === field.key || !onReorderFields || !configFields) return;
                  const keys = configFields.map(f => f.key);
                  const fi = keys.indexOf(from);
                  const ti = keys.indexOf(field.key);
                  if (fi === -1 || ti === -1) return;
                  const next = [...keys];
                  next.splice(fi, 1);
                  next.splice(ti, 0, from);
                  onReorderFields(next);
                }}
                onDragEnd={() => {
                  dragKeyRef.current = null;
                  setDragOverKey(null);
                }}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors select-none',
                  dragOverKey === field.key ? 'bg-primary/10' : 'hover:bg-secondary',
                  field.always && 'opacity-50 cursor-default',
                )}
              >
                {!field.always && onReorderFields && (
                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-grab" />
                )}
                <input
                  type="checkbox"
                  checked={!field.hidden}
                  disabled={field.always}
                  onChange={() => !field.always && onToggleField(field.key)}
                  className="h-3.5 w-3.5 accent-primary shrink-0"
                />
                <span className="text-[13px] text-foreground truncate">{field.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Tabs */}
          {tabs && tabs.length > 1 && (
            <div className="flex gap-1 bg-secondary rounded-lg p-0.5 mx-4 mt-3 shrink-0">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'flex-1 px-2 py-1.5 text-[12px] font-medium transition-colors rounded-md whitespace-nowrap',
                    activeTab === tab.key
                      ? 'bg-surface text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {/* Scrollable content — key remount triggers enter animation on tab switch;
              data-state animates on panel open/close via globals.css */}
          <div
            key={activeTab}
            data-state={contentState}
            data-variant="content"
            className="flex-1 overflow-y-auto p-4"
          >
            {activeContent}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Helpers for building panel content ───────────────────────────────────── */

/** Single labeled field row */
export function PanelField({
  label,
  value,
  className,
  fieldKey: _fieldKey,
  hidden,
}: {
  label: string;
  value?: ReactNode;
  className?: string;
  /** For panel config — used externally to identify the field */
  fieldKey?: string;
  /** If true, field is not rendered (controlled by useDetailPanelConfig) */
  hidden?: boolean;
}) {
  if (hidden) return null;
  const isEmpty = value === null || value === undefined || value === '';
  // When fieldKey is provided (field is part of panel config), show "—" instead
  // of hiding — so users can see the field exists even when the object has no value.
  if (isEmpty && !_fieldKey) return null;
  if (isEmpty) {
    return (
      <div className={cn('space-y-0.5', className)}>
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>
        <div className="text-[13px] text-muted-foreground">—</div>
      </div>
    );
  }
  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <div className="text-[13px] text-foreground">{value}</div>
    </div>
  );
}

/** Section with optional heading */
export function PanelSection({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      {title && (
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {title}
        </p>
      )}
      {children}
    </div>
  );
}
