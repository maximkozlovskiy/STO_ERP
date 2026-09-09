import { describe, it, expect } from 'vitest';
import { validateContactFields } from '../validation';

// T11: клієнтська Zod-валідація на спільних @sto/shared схемах.
describe('validateContactFields', () => {
  it('порожні/undefined поля → валідні (null)', () => {
    expect(validateContactFields({})).toBeNull();
    expect(validateContactFields({ email: '', phone: '', iban: '' })).toBeNull();
    expect(validateContactFields({ email: '   ' })).toBeNull(); // trim → порожнє
  });

  it('валідний email → null', () => {
    expect(validateContactFields({ email: 'client@sto.ua' })).toBeNull();
  });

  it('невалідний email → повідомлення', () => {
    expect(validateContactFields({ email: 'not-an-email' })).toBe('Невірний формат email');
    expect(validateContactFields({ email: 'a@b' })).toBe('Невірний формат email');
  });

  it('валідний нормалізований телефон +380XXXXXXXXX → null', () => {
    expect(validateContactFields({ phone: '+380671234567' })).toBeNull();
  });

  it('невалідний телефон → повідомлення', () => {
    expect(validateContactFields({ phone: '0671234567' })).toContain('формат телефону');
  });

  it('валідний IBAN → null; невалідний → повідомлення', () => {
    expect(validateContactFields({ iban: 'UA' + '1'.repeat(27) })).toBeNull();
    expect(validateContactFields({ iban: 'UA123' })).toContain('IBAN');
  });

  it('повертає ПЕРШУ помилку (телефон перед email)', () => {
    const msg = validateContactFields({ phone: 'bad', email: 'also-bad' });
    expect(msg).toContain('телефон');
  });
});
