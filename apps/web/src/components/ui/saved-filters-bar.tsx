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
  /** When true — hides the inline "Зберегти" button. Use SaveFilterButton instead. */
  hideSaveButton?: boolean;
}

export function SavedFiltersBar<T extends Record<string, unknown>>({
  saved,
  activeId,
  onApply,
  onSave,
  onRemove,
  className,
  hideSaveButton,
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
      {saved.length > 0 ? (
        <Bookmark className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
      ) : (
        !saveOpen &&
        !hideSaveButton && (
          <span className="text-[12px] text-muted-foreground">Немає збережених подань</span>
        )
      )}

      {saved.map(preset => (
        <div key={preset.id} className="group flex items-center gap-0.5">
          {/* Bug #314: type="button" щоб клік не submit-ив батьківську форму. */}
          <button
            type="button"
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
            type="button"
            onClick={() => onRemove(preset.id)}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-destructive"
            aria-label={`Видалити подання "${preset.name}"`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {!hideSaveButton &&
        (saveOpen ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setSaveOpen(false);
              }}
              placeholder="Назва подання..."
              className="h-7 px-2 rounded-md border border-primary text-[12px] bg-surface text-foreground outline-none w-36"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!saveName.trim()}
              className="h-7 px-2.5 rounded-md bg-primary text-white text-[12px] font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Зберегти
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveOpen(false);
                setSaveName('');
              }}
              className="h-7 w-7 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded-md border border-dashed border-border text-[12px] text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            Зберегти
          </button>
        ))}
    </div>
  );
}

// ─── Standalone save-filter button — icon only, placed before ColumnsDropdown ─

interface SaveFilterButtonProps {
  onSave: (name: string) => void;
  className?: string;
}

export function SaveFilterButton({ onSave, className }: SaveFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
    setOpen(false);
  };

  if (open) {
    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') {
              setOpen(false);
              setName('');
            }
          }}
          placeholder="Назва подання..."
          className="h-8 px-2.5 rounded-lg border border-primary text-[12px] bg-surface text-foreground outline-none w-36 transition-all"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!name.trim()}
          className="h-8 px-3 rounded-lg bg-primary text-white text-[12px] font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Зберегти
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setName('');
          }}
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title="Зберегти подання"
      className={cn(
        'h-8 w-8 flex items-center justify-center rounded-lg border border-border',
        'text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors',
        className,
      )}
    >
      <BookmarkPlus className="h-4 w-4" />
    </button>
  );
}
