export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<ToastListener>();

function notify() {
  listeners.forEach(fn => fn([...items]));
}

function add(type: ToastType, message: string, duration = 4000): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  items = [...items, { id, type, message, duration }];
  notify();

  setTimeout(() => remove(id), duration);
  return id;
}

export function remove(id: string) {
  items = items.filter(t => t.id !== id);
  notify();
}

export function subscribe(fn: ToastListener): () => void {
  listeners.add(fn);
  fn([...items]);
  return () => listeners.delete(fn);
}

export const toast = {
  success: (message: string, duration?: number) => add('success', message, duration),
  error:   (message: string, duration?: number) => add('error',   message, duration ?? 6000),
  warning: (message: string, duration?: number) => add('warning', message, duration),
  info:    (message: string, duration?: number) => add('info',    message, duration),
};
