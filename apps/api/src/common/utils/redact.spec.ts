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

  it('ігнорує лише вироджені значення (порожнє / 1-2 символи, не псує весь текст)', () => {
    // "1"/"ab" — надто короткі щоб бути секретом; замаскували б випадкові входження у тексті.
    expect(redactSecrets('http 400: ab1c not found', ['', null, undefined, '1', 'ab'])).toBe(
      'http 400: ab1c not found',
    );
  });

  it('маскує 4-значний Checkbox pin_code, віддзеркалений у тілі 4xx (регресія: PIN leak)', () => {
    // Реальний касирський PIN = рівно 4 цифри. Провайдер ехо-їть надісланий pin_code у 400.
    // Поро̆г >=6 пропускав би 4-значний PIN → він витік би у IntegrationLog.error.
    const body = 'Checkbox 400: invalid credentials for pin_code=1234';
    expect(redactSecrets(body, ['1234', 'LICENSE-KEY-LONG'])).toBe(
      'Checkbox 400: invalid credentials for pin_code=***',
    );
  });

  it('маскує 3-символьний секрет (нижня межа порогу)', () => {
    expect(redactSecrets('key=abc rejected', ['abc'])).toBe('key=*** rejected');
  });

  it('пропускає 2-символьний секрет (нижче порогу — не маскується)', () => {
    expect(redactSecrets('code ab here', ['ab'])).toBe('code ab here');
  });

  it('не падає і не над-маскує на секреті зі спецсимволами regex (split/join, не RegExp)', () => {
    // "+()[].*" — якби redact будував RegExp, це б кинуло або зжерло півтексту.
    const weird = 'a+b(c)[d].*e';
    expect(redactSecrets(`token ${weird} end 1+1 [x]`, [weird])).toBe('token *** end 1+1 [x]');
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
