/**
 * Інваріант BR-SDOC-005: `STOCK_DOC_TYPE_LABELS` у `@sto/shared` — єдине джерело
 * переліку типів складського документа для фронту (таб-бар, фільтр, select у модалці
 * читають `Object.keys(STOCK_DOC_TYPE_LABELS)`).
 *
 * Звідси тиха поломка: новий тип у Prisma-enum БЕЗ запису у shared не дає жодної помилки
 * компіляції (мапа — `Record<string, string>`), а на екрані тип просто відсутній: ні
 * вкладки, ні фільтра, ні пункту в модалці створення. І навпаки — зайвий ключ у shared
 * малює вкладку, яку backend відхилить 400-кою (`@IsEnum`).
 *
 * Спек лежить в api, бо лише тут доступні обидві сторони: Prisma-enum і shared.
 */

import { StockDocumentType } from '@prisma/client';
import { STOCK_DOC_TYPE_LABELS } from '@sto/shared';
import { describe, it, expect } from 'vitest';

describe('STOCK_DOC_TYPE_LABELS ↔ StockDocumentType (BR-SDOC-005)', () => {
  // guards: BR-SDOC-005
  it('ключі мапи збігаються з Prisma-enum StockDocumentType — жодного пропущеного і жодного зайвого', () => {
    expect(Object.keys(STOCK_DOC_TYPE_LABELS).sort()).toEqual(
      Object.values(StockDocumentType).sort(),
    );
  });

  // guards: BR-SDOC-005
  it('кожен тип має непорожню назву кирилицею (не сирий enum-код)', () => {
    for (const type of Object.values(StockDocumentType)) {
      const label = STOCK_DOC_TYPE_LABELS[type];
      expect(label, `назва для ${type}`).toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
      expect(label).not.toBe(type);
    }
  });
});
