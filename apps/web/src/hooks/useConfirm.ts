import { useState, useCallback } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
}

/**
 * Діалог підтвердження як проміс. Над карткою-вікном Escape закриває лише підтвердження: воно
 * `<Modal>`, тобто верхній шар Escape (`useEscapeLayer`), і до картки клавіша не доходить.
 */
export function useConfirm() {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (v: boolean | null) => void; dismissAsNull: boolean }) | null
  >(null);

  const ask = useCallback(
    (opts: ConfirmOptions, dismissAsNull: boolean): Promise<boolean | null> =>
      new Promise<boolean | null>(resolve => {
        setState({ ...opts, resolve, dismissAsNull });
      }),
    [],
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

  return { confirm, choose, dialogProps };
}
