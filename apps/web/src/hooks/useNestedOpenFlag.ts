'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Прапорець «над карткою відкрите вкладене вікно» (вікно вибору, картка контрагента чи товару) для
 * `handleClose` картки: `<Modal>` і вкладене вікно слухають Escape на document, тож без прапорця
 * той самий Escape закривав би й картку (Bug #923, #931).
 *
 * Знімається ПІСЛЯ події, а не в ефекті (GOTCHAS 2026-10-12): у браузері React рендерить між двома
 * слухачами того самого Escape, і картка побачила б уже `false`. Таймер скасовується, якщо вікно
 * відкрили знову до його спрацювання.
 */
export function useNestedOpenFlag(nestedOpen: boolean): MutableRefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    if (nestedOpen) {
      ref.current = true;
      return;
    }
    const timer = setTimeout(() => {
      ref.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [nestedOpen]);
  return ref;
}
