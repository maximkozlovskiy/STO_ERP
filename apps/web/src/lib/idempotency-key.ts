/**
 * Ключ ідемпотентності для мутацій, які не можна виконати двічі (оплата, касова операція,
 * відправка замовлення постачальнику). `crypto.randomUUID` є лише в secure context, а on-prem
 * сервер СТО відкривають по http у LAN — тоді UUID v4 збирається з `crypto.getRandomValues`,
 * який secure context не вимагає. Раніше запасний варіант брав `Math.random` (sonarjs/pseudo-random).
 */
export const newIdempotencyKey = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidV4FromRandomValues();

function uuidV4FromRandomValues(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // версія 4
  b[8] = (b[8] & 0x3f) | 0x80; // варіант RFC 4122
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
