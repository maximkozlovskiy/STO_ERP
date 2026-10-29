'use client';

import { Trash2 } from 'lucide-react';
import { Button } from './button';

interface RowDeleteButtonProps {
  /** Підказка й доступна назва («Позначити на видалення»). */
  title: string;
  onClick: () => void;
}

/**
 * Кнопка «позначити на видалення» в рядку списку: видно при наведенні на рядок (`group`) і при
 * фокусі з клавіатури. Одна розмітка для всіх списків документів.
 */
export function RowDeleteButton({ title, onClick }: RowDeleteButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}
