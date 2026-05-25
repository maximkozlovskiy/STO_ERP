'use client';

import { useState, useRef, useEffect } from 'react';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type SavedFilter } from '@/hooks/useSavedFilters';

interface SavedFiltersBarProps<T extends Record<string, unknown>> {
  saved: SavedFilter<T>[];
  activeId?: string | null;
  onApply: (preset: SavedFilter<T>) => void;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
  className?: string;
}

export function SavedFiltersBar<T extends Record<string, unknown>>({
  saved,
  activeId,
  onApply,
  onSave,
  onRemove,
  className,
}: SavedFiltersBarProps<T>) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!saveOpen) return;
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [saveOpen]);

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaveName('');
    setSaveOpen(false);
  };

  return (
    <div className={cn('flex items-center gap-1.5 flex-wrap', className)}>
      <Bookmark className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />

      {saved.length === 0 && !saveOpen && (
        <span className="text-[12px] text-muted-foreground">Немає збережених фільтрів</span>
      )}

      {saved.map(preset => (
        <div key={preset.id} className="group flex items-center gap-0.5">
          <button
            onClick={() => onApply(preset)}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors border',
              activeId === preset.id
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-foreground border-border hover:border-primary/50 hover:bg-primary-subtle',
            )}
          >
            {preset.name}
          </button>
          <button
            onClick={() => onRemove(preset.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-destructive"
            aria-label={`Видалити фільтр "${preset.name}"`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {saveOpen ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setSaveOpen(false); }}
            placeholder="Назва фільтру..."
            className="h-7 px-2 rounded-md border border-primary text-[12px] bg-surface text-foreground outline-none w-36"
          />
          <button
            onClick={handleSave}
            disabled={!saveName.trim()}
            className="h-7 px-2.5 rounded-md bg-primary text-white text-[12px] font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Зберегти
          </button>
          <button
            onClick={() => { setSaveOpen(false); setSaveName(''); }}
            className="h-7 w-7 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setSaveOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded-md border border-dashed border-border text-[12px] text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          Зберегти
        </button>
      )}
    </div>
  );
}
