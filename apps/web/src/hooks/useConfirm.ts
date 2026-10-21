import { useState, useCallback, useRef, type MutableRefObject } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
}

/**
 * Знімає прапорець «вкладене вікно відкрите» ПІСЛЯ поточної події, а не одразу: Escape вкладеного
 * вікна ще обходить слухачі вікна-власника, і без затримки той самий Escape закрив би й його
 * (GOTCHAS 2026-10-12).
 */
export function releaseNestedOpen(ref: MutableRefObject<boolean>): void {
  setTimeout(() => {
    ref.current = false;
  }, 0);
}

/**
 * Діалог підтвердження як проміс. `openRef` — «підтвердження відкрите»: true від `confirm()` до
 * відповіді, знімається після події (`releaseNestedOpen`). Вікно-власник ігнорує свій Escape,
 * поки прапорець стоїть. `nestedOpenRef` — прапорець власника, коли його веде не цей хук (блок
 * усередині картки позначає підтвердження в прапорці картки).
 */
export function useConfirm(nestedOpenRef?: MutableRefObject<boolean>) {
  const ownOpenRef = useRef(false);
  const openRef = nestedOpenRef ?? ownOpenRef;
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(
    null,
  );

  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> => {
      openRef.current = true;
      return new Promise<boolean>(resolve => {
        setState({ ...opts, resolve });
      }).then(ok => {
        releaseNestedOpen(openRef);
        return ok;
      });
    },
    [openRef],
  );

  const handleConfirm = useCallback(() => {
    setState(s => {
      s?.resolve(true);
      return null;
    });
  }, []);

  const handleCancel = useCallback(() => {
    setState(s => {
      s?.resolve(false);
      return null;
    });
  }, []);

  const dialogProps = state
    ? { open: true as const, ...state, onConfirm: handleConfirm, onCancel: handleCancel }
    : { open: false as const };

  return { confirm, dialogProps, openRef };
}
