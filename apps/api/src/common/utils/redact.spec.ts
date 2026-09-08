import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('замінює секрет на *** (провайдер віддзеркалив apiKey у тілі помилки)', () => {
    const key = 'a1b2c3d4-secret-key-9999';
    expect(redactSecrets(`invalid apiKey ${key} rejected`, [key])).toBe(
      'invalid apiKey *** rejected',
    );
  });

  it('замінює усі входження секрету', () => {
    const s = 'topsecret';
    expect(redactSecrets(`${s} ... ${s}`, [s])).toBe('*** ... ***');
  });

  it('ігнорує порожні/короткі значення (не псує весь текст)', () => {
    expect(redactSecrets('http 400: not found', ['', null, undefined, '1', 'abc'])).toBe(
      'http 400: not found',
    );
  });

  it('обробляє кілька секретів', () => {
    expect(redactSecrets('pin=123456 key=abcdef123', ['123456', 'abcdef123'])).toBe(
      'pin=*** key=***',
    );
  });

  it('повертає текст без змін, якщо секретів немає у ньому', () => {
    expect(redactSecrets('Нова Пошта 500: internal error', ['someUnusedKey12345'])).toBe(
      'Нова Пошта 500: internal error',
    );
  });
});
