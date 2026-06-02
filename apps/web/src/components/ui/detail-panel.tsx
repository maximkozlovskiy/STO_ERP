'use client';

import { type ReactNode, useState, useEffect } from 'react';
import { X, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DetailPanelTab {
  key: string;
  label: string;
  content: ReactNode;
}

export interface PanelConfigField {
  key: string;
  label: string;
  hidden: boolean;
}

interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional subtitle shown below title */
  subtitle?: string;
  /** If provided, renders tabs instead of children */
  tabs?: DetailPanelTab[];
  /** Used when no tabs — plain content */
  children?: ReactNode;
  /** Default active tab key */
  defaultTab?: string;
  /** Fields available for visibility toggling */
  configFields?: PanelConfigField[];
  /** Called when user toggles a field's visibility */
  onToggleField?: (fieldKey: string) => void;
  /** Called when user resets config to defaults */
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
  onReset,
}: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState(defaultTab ?? tabs?.[0]?.key ?? '');
  const [showConfig, setShowConfig] = useState(false);

  // Reset to first tab and close config when item changes
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
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-foreground">Налаштування панелі</span>
            <button
              type="button"
              onClick={() => {
                onReset?.();
              }}
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Скинути
            </button>
          </div>
          {configFields.map(field => (
            <label key={field.key} className="flex items-center gap-2 py-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={!field.hidden}
                onChange={() => onToggleField(field.key)}
                className="h-3.5 w-3.5 accent-primary"
              />
              <span className="text-[13px] text-foreground">{field.label}</span>
            </label>
          ))}
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

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-4">{activeContent}</div>
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
