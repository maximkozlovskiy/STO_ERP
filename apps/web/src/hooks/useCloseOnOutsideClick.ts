import { useEffect, type RefObject } from 'react';

/**
 * Закриває розгорнуте меню (статусу документа тощо) натиском миші поза `ref`. Слухач висить лише,
 * поки меню відкрите. Одна реалізація для карток документів замість копії ефекту в кожній
 * (CI-гейт нових клонів).
 *
 * `setOpen` — сетер стану (`useState`), стабільний між рендерами.
 */
export function useCloseOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, ref, setOpen]);
}
