/**
 * Ключ ідемпотентності для мутацій, які не можна виконати двічі (оплата, касова операція,
 * відправка замовлення постачальнику). `crypto.randomUUID` є лише в secure context, а on-prem
 * сервер СТО відкривають по http у LAN — тоді запасний варіант із часу й випадкових чисел.
 */
export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
