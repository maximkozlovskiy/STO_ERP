'use client';

import { type ReactNode, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DetailPanelTab {
  key: string;
  label: string;
  content: ReactNode;
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
}

export function DetailPanel({ open, onClose, title, subtitle, tabs, children, defaultTab }: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState(defaultTab ?? tabs?.[0]?.key ?? '');

  // Reset to first tab when item changes (open toggles or title changes)
  useEffect(() => {
    if (defaultTab) setActiveTab(defaultTab);
    else if (tabs?.[0]) setActiveTab(tabs[0].key);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const activeContent = tabs?.find(t => t.key === activeTab)?.content ?? children;

  return (
    <div
      className={cn(
        'flex flex-col shrink-0 bg-surface transition-[width,margin] duration-200 overflow-hidden rounded-xl border border-border',
        open ? 'w-80 ml-3' : 'w-0 ml-0 border-transparent',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-foreground truncate leading-tight">{title}</h2>
          {subtitle && (
            <p className="text-[12px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 ml-2"
          title="Закрити"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tabs */}
      {tabs && tabs.length > 1 && (
        <div className="flex border-b border-border shrink-0 px-1 pt-1 gap-0.5 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'px-3 py-1.5 text-[12px] font-medium rounded-t-md transition-colors whitespace-nowrap border-b-2 -mb-px',
                activeTab === tab.key
                  ? 'text-primary border-primary bg-primary/5'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-secondary',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeContent}
      </div>
    </div>
  );
}

/* ── Helpers for building panel content ───────────────────────────────────── */

/** Single labeled field row */
export function PanelField({ label, value, className }: { label: string; value?: ReactNode; className?: string }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="text-[13px] text-foreground">{value}</div>
    </div>
  );
}

/** Section with optional heading */
export function PanelSection({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {title && (
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      )}
      {children}
    </div>
  );
}
