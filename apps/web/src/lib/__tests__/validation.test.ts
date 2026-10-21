import { describe, it, expect } from 'vitest';
import { validateContactFields, validationText } from '../validation';

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

// Bug #934: ручний safeParse спільної схеми віддає ключ перекладу — у банер іде лише через validationText.
describe('validationText', () => {
  it('ключ схеми наряду → текст мовою інтерфейсу', () => {
    expect(validationText('v.workOrder.counterparty.required')).not.toMatch(/^v\./);
    expect(validationText('v.purchaseOrder.warehouse.required')).toBe('Оберіть склад');
  });

  it('готовий текст (запасне повідомлення) лишається як є', () => {
    expect(validationText('Перевірте правильність заповнення полів')).toBe(
      'Перевірте правильність заповнення полів',
    );
  });
});
