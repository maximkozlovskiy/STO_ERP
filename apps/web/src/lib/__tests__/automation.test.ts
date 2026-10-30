// Підписи й посилання журналу автоматизації (docs/objects/automation.md, BR-AUT-016, 021, 050).

import { afterEach, describe, expect, it } from 'vitest';
import { AUTOMATION_SKIP_REASONS } from '@sto/shared';
import i18n from '@/i18n/config';
import { automationDocumentHref, automationSkipReasonLabel } from '../automation';

const ID = '11111111-1111-4111-8111-000000000001';

afterEach(async () => {
  await i18n.changeLanguage('uk');
});

describe('журнал автоматизації — причини пропуску', () => {
  // guards: BR-AUT-050
  it.each(['uk', 'en'])(
    'кожен код AUTOMATION_SKIP_REASONS має підпис мовою %s, не сам код',
    async lng => {
      await i18n.changeLanguage(lng);
      for (const code of AUTOMATION_SKIP_REASONS) {
        const label = automationSkipReasonLabel(code);
        expect(label, code).not.toBe(code);
        expect(label.trim(), code).not.toBe('');
      }
    },
  );

  // guards: BR-AUT-016
  it('DOCUMENT_CANCELLED — «документ скасовано до відправки»; невідомий код — як є', () => {
    expect(automationSkipReasonLabel('DOCUMENT_CANCELLED')).toBe('документ скасовано до відправки');
    expect(automationSkipReasonLabel('PAYMENT_REVERSED')).toBe('оплату сторновано до відправки');
    expect(automationSkipReasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(automationSkipReasonLabel(null)).toBe('');
  });
});

describe('посилання на документ з дзвіночка й журналу', () => {
  // guards: BR-AUT-021
  it('документ відкривається карткою списку (?open=), повернення — ?openReturn=', () => {
    expect(automationDocumentHref('WORK_ORDER', ID, 'ADMIN')).toBe(`/work-orders?open=${ID}`);
    expect(automationDocumentHref('INVOICE', ID, 'ACCOUNTANT')).toBe(`/invoices?open=${ID}`);
    expect(automationDocumentHref('TASK', ID, 'MECHANIC')).toBe(`/tasks?open=${ID}`);
    expect(automationDocumentHref('SUPPLIER_RETURN', ID, 'OWNER')).toBe(
      `/purchase-orders?openReturn=${ID}`,
    );
  });

  // guards: BR-AUT-021
  it('роль без доступу до сторінки документа — посилання немає (лише текст)', () => {
    expect(automationDocumentHref('INVOICE', ID, 'MECHANIC')).toBeNull();
    expect(automationDocumentHref('STOCK_DOCUMENT', ID, 'RECEPTIONIST')).toBeNull();
    expect(automationDocumentHref('WORK_ORDER', ID, null)).toBeNull();
    expect(automationDocumentHref(null, ID, 'ADMIN')).toBeNull();
  });
});
