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
 * відповіді, знімається після події (як `releaseNestedOpen`). Вікно-власник ігнорує свій Escape,
 * поки прапорець стоїть. `nestedOpenRef` — прапорець власника, коли його веде не цей хук (блок
 * усередині картки позначає підтвердження в прапорці картки).
 */
export function useConfirm(nestedOpenRef?: MutableRefObject<boolean>) {
  const ownOpenRef = useRef(false);
  const openRef = nestedOpenRef ?? ownOpenRef;
  // Номер останнього `confirm()`: відкладене зняття прапорця від попереднього підтвердження не
  // знімає його, якщо виклик одразу відкрив наступне (інакше Escape другого закрив би власника).
  const seqRef = useRef(0);
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (v: boolean | null) => void; dismissAsNull: boolean }) | null
  >(null);

  const ask = useCallback(
    (opts: ConfirmOptions, dismissAsNull: boolean): Promise<boolean | null> => {
      openRef.current = true;
      const seq = ++seqRef.current;
      return new Promise<boolean | null>(resolve => {
        setState({ ...opts, resolve, dismissAsNull });
      }).then(ok => {
        setTimeout(() => {
          if (seqRef.current === seq) openRef.current = false;
        }, 0);
        return ok;
      });
    },
    [openRef],
  );

  /** Так / ні. Escape, хрестик і клік поза вікном — «ні». */
  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> => ask(opts, false).then(ok => ok === true),
    [ask],
  );

  /**
   * Вибір із двох ДІЙ, коли «ні» — теж дія («Тільки перевести статус»): Escape, хрестик і клік поза
   * вікном дають `null` — відмову від обох (Bug #926: Escape переводив наряд у «Виставлено»).
   */
  const choose = useCallback(
    (opts: ConfirmOptions): Promise<boolean | null> => ask(opts, true),
    [ask],
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

  const handleDismiss = useCallback(() => {
    setState(s => {
      s?.resolve(s.dismissAsNull ? null : false);
      return null;
    });
  }, []);

  const dialogProps = state
    ? {
        open: true as const,
        ...state,
        onConfirm: handleConfirm,
        onCancel: handleCancel,
        onDismiss: handleDismiss,
      }
    : { open: false as const };

  return { confirm, choose, dialogProps, openRef };
}
