'use client';

import { useRef, useState } from 'react';
import { GripVertical, Eye, EyeOff, Plus, Pencil, Trash2, RotateCcw, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveNav, type NavLayout } from '@/lib/nav-layout';
import { MASTER_NAV_ITEMS } from '@/lib/nav';

interface NavConfigApi {
  layout: NavLayout;
  toggleItem: (href: string) => void;
  toggleSection: (id: string) => void;
  reorderItems: (sectionId: string, order: string[]) => void;
  moveItemToSection: (href: string, sectionId: string, targetOrder?: string[]) => void;
  reorderSections: (order: string[]) => void;
  addSection: (label: string) => string;
  renameSection: (id: string, label: string) => void;
  removeSection: (id: string) => void;
  reset: () => void;
}

interface NavEditorProps {
  role: string | undefined;
  nav: NavConfigApi;
  onClose: () => void;
}

interface DragState {
  href: string;
  fromSection: string;
}

/**
 * Режим редагування бокового меню: drag-reorder пунктів у межах розділу й між розділами,
 * приховування пунктів/розділів (око), створення/перейменування/видалення кастомних розділів,
 * reorder розділів, «Скинути». Всі зміни — per-user через useNavConfig (миттєвий прев'ю).
 */
export function NavEditor({ role, nav, onClose }: NavEditorProps) {
  const sections = resolveNav(MASTER_NAV_ITEMS, nav.layout, role, true);
  const dragRef = useRef<DragState | null>(null);
  const sectionDragRef = useRef<string | null>(null);
  const [newSectionName, setNewSectionName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Порядок пунктів секції (усі — видимі+приховані, у поточному порядку).
  const sectionHrefs = (sectionId: string): string[] => {
    const sec = sections.find(s => s.id === sectionId);
    if (!sec) return [];
    return [...sec.items, ...sec.hiddenItems].map(i => i.href);
  };

  const onItemDrop = (targetSectionId: string, targetHref: string | null) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.fromSection === targetSectionId) {
      // reorder у межах секції
      const order = sectionHrefs(targetSectionId).filter(h => h !== drag.href);
      const idx = targetHref ? order.indexOf(targetHref) : order.length;
      order.splice(idx < 0 ? order.length : idx, 0, drag.href);
      nav.reorderItems(targetSectionId, order);
    } else {
      // перенесення у іншу секцію на позицію targetHref
      const order = sectionHrefs(targetSectionId).filter(h => h !== drag.href);
      const idx = targetHref ? order.indexOf(targetHref) : order.length;
      order.splice(idx < 0 ? order.length : idx, 0, drag.href);
      nav.moveItemToSection(drag.href, targetSectionId, order);
    }
  };

  const onSectionDrop = (targetId: string) => {
    const from = sectionDragRef.current;
    sectionDragRef.current = null;
    if (!from || from === targetId) return;
    const order = sections.map(s => s.id).filter(id => id !== from);
    const idx = order.indexOf(targetId);
    order.splice(idx < 0 ? order.length : idx, 0, from);
    nav.reorderSections(order);
  };

  const startRename = (id: string, label: string) => {
    setRenamingId(id);
    setRenameValue(label);
  };
  const commitRename = () => {
    if (renamingId) nav.renameSection(renamingId, renameValue.trim() || 'Розділ');
    setRenamingId(null);
  };

  const addSection = () => {
    const name = newSectionName.trim();
    if (!name) return;
    nav.addSection(name);
    setNewSectionName('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border shrink-0">
        <span className="text-[13px] font-semibold text-white">Налаштування меню</span>
        <button
          onClick={onClose}
          className="h-7 w-7 flex items-center justify-center rounded-md text-sidebar-muted hover:text-white hover:bg-sidebar-hover"
          title="Готово"
        >
          <Check className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {sections.map(section => {
          const rows = [
            ...section.items.map(i => ({ item: i, hidden: false })),
            ...section.hiddenItems.map(i => ({ item: i, hidden: true })),
          ];
          return (
            <div
              key={section.id}
              className={cn(
                'rounded-lg border border-sidebar-border',
                section.hidden && 'opacity-60',
              )}
              draggable
              onDragStart={() => {
                sectionDragRef.current = section.id;
              }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                if (sectionDragRef.current) onSectionDrop(section.id);
              }}
            >
              {/* Section header */}
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sidebar-border">
                <GripVertical className="h-3.5 w-3.5 text-sidebar-muted cursor-grab shrink-0" />
                {renamingId === section.id ? (
                  <input
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={commitRename}
                    autoFocus
                    className="flex-1 min-w-0 bg-sidebar-hover text-white text-[11px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 outline-none"
                  />
                ) : (
                  <span className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-sidebar-muted">
                    {section.label || 'Без назви'}
                  </span>
                )}
                <button
                  onClick={() => nav.toggleSection(section.id)}
                  className="h-6 w-6 flex items-center justify-center rounded text-sidebar-muted hover:text-white"
                  title={section.hidden ? 'Показати розділ' : 'Сховати розділ'}
                >
                  {section.hidden ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                {section.custom && renamingId !== section.id && (
                  <button
                    onClick={() => startRename(section.id, section.label)}
                    className="h-6 w-6 flex items-center justify-center rounded text-sidebar-muted hover:text-white"
                    title="Перейменувати"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                {section.custom && (
                  <button
                    onClick={() => nav.removeSection(section.id)}
                    className="h-6 w-6 flex items-center justify-center rounded text-sidebar-muted hover:text-red-400"
                    title="Видалити розділ (пункти повернуться у типові розділи)"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Items */}
              <div
                className="p-1 space-y-0.5 min-h-2"
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  if (dragRef.current) onItemDrop(section.id, null);
                }}
              >
                {rows.length === 0 && (
                  <p className="px-2 py-1 text-[11px] text-sidebar-muted italic">
                    Перетягніть пункти сюди
                  </p>
                )}
                {rows.map(({ item, hidden }) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.href}
                      draggable
                      onDragStart={e => {
                        e.stopPropagation();
                        dragRef.current = { href: item.href, fromSection: section.id };
                      }}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (dragRef.current) onItemDrop(section.id, item.href);
                      }}
                      className={cn(
                        'group flex items-center gap-2 rounded px-1.5 py-1 text-[13px] cursor-grab',
                        hidden ? 'text-sidebar-muted opacity-60' : 'text-sidebar-fg',
                        'hover:bg-sidebar-hover',
                      )}
                    >
                      <GripVertical className="h-3.5 w-3.5 text-sidebar-muted shrink-0" />
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                      <button
                        onClick={() => nav.toggleItem(item.href)}
                        className="h-6 w-6 flex items-center justify-center rounded text-sidebar-muted hover:text-white shrink-0"
                        title={hidden ? 'Показати' : 'Сховати'}
                      >
                        {hidden ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer: add section + reset */}
      <div className="shrink-0 border-t border-sidebar-border p-2 space-y-2">
        <div className="flex items-center gap-1.5">
          <input
            value={newSectionName}
            onChange={e => setNewSectionName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addSection();
            }}
            placeholder="Новий розділ"
            className="flex-1 min-w-0 bg-sidebar-hover text-white text-[12px] rounded px-2 py-1.5 outline-none placeholder:text-sidebar-muted"
          />
          <button
            onClick={addSection}
            disabled={!newSectionName.trim()}
            title="Додати розділ"
            aria-label="Додати розділ"
            className="h-7 px-2 flex items-center gap-1 rounded-md bg-primary hover:bg-primary-hover text-white text-[12px] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          onClick={nav.reset}
          className="w-full flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] text-sidebar-muted hover:text-white hover:bg-sidebar-hover"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Скинути до типового
        </button>
      </div>
    </div>
  );
}
