import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdempotencyKey } from '../idempotency-key';

// RFC 4122 v4: версія `4` у 13-му символі, варіант `8|9|a|b` у 17-му.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newIdempotencyKey', () => {
  afterEach(() => vi.restoreAllMocks());

  it('є crypto.randomUUID (secure context) — бере його', () => {
    const spy = vi.spyOn(crypto, 'randomUUID');
    expect(newIdempotencyKey()).toMatch(UUID_V4);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Сервер СТО по http у LAN: randomUUID немає, ключ збирається з getRandomValues.
  it('без randomUUID — UUID v4 з getRandomValues, біти версії й варіанта виставлені', () => {
    // Власна властивість затіняє метод прототипу Crypto; `delete` у finally його повертає.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    const rnd = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
        (a as unknown as Uint8Array).fill(0xff);
        return a;
      });
    try {
      const key = newIdempotencyKey();
      expect(rnd).toHaveBeenCalledTimes(1);
      expect(key).toMatch(UUID_V4);
      // 0xff & 0x0f | 0x40 = 0x4f; 0xff & 0x3f | 0x80 = 0xbf.
      expect(key).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  });
});
