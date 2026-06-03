import { useState, useCallback } from 'react';

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
}

export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(
    null,
  );

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ ...opts, resolve });
    });
  }, []);

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

  return { confirm, dialogProps };
}
