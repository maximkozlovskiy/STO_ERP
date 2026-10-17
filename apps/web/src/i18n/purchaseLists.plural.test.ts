// Bug #888: лічильники діалогів «Управління купівлями» мали одну форму — «Перенести 1 позицій»,
// «Обʼєднати 5 списки». Рядки з {{count}} у заголовках і підтвердженнях — ключі множини
// (`_one/_few/_many/_other`), як `common.linesSummary.positions_*`.
//
// Мутація: повернути одну форму `moveTitle` → i18next віддає ключ / ту саму форму → кейси падають.
import { describe, it, expect } from 'vitest';
import i18n from './config';

const t = (lng: 'uk' | 'en', key: string, count: number) =>
  i18n.getFixedT(lng, 'purchaseLists')(key, { count });

describe('purchaseLists: множина лічильників (Bug #888)', () => {
  it.each([
    [1, 'Перенести 1 позицію'],
    [3, 'Перенести 3 позиції'],
    [5, 'Перенести 5 позицій'],
    [21, 'Перенести 21 позицію'],
  ])('uk moveTitle, %i', (count, text) => {
    expect(t('uk', 'items.dialogs.moveTitle', count)).toBe(text);
  });

  it('uk: обʼєднання, скасування, замовлення', () => {
    expect(t('uk', 'lists.mergeTitle', 2)).toBe('Обʼєднати 2 списки');
    expect(t('uk', 'lists.mergeTitle', 5)).toBe('Обʼєднати 5 списків');
    expect(t('uk', 'items.cancelConfirm', 1)).toBe('Скасувати 1 позицію?');
    expect(t('uk', 'items.createOrdersConfirm', 1)).toBe(
      'Створити замовлення постачальникам з 1 позиції?',
    );
    expect(t('uk', 'items.dialogs.supplierTitle', 2)).toBe('Постачальник і ціна — 2 позиції');
  });

  it('en: one / other', () => {
    expect(t('en', 'items.dialogs.moveTitle', 1)).toBe('Move 1 item');
    expect(t('en', 'items.dialogs.moveTitle', 4)).toBe('Move 4 items');
    expect(t('en', 'lists.mergeTitle', 3)).toBe('Merge 3 lists');
  });
});
