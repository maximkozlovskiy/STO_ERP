import { describe, it, expect } from 'vitest';
import { parsePurpose } from './purpose-parser';

describe('parsePurpose', () => {
  it('витягує номер рахунку з «рахунок №»', () => {
    const r = parsePurpose('Оплата за рахунком № INV-2026/07 за послуги');
    expect(r.invoiceNumber).toBe('INV-2026/07');
  });

  it('витягує номер рахунку з різних відмінків («рахунку №123»)', () => {
    expect(parsePurpose('Згідно рахунку №123').invoiceNumber).toBe('123');
    expect(parsePurpose('оплата рахунок 456').invoiceNumber).toBe('456');
  });

  it('витягує номер наряду з латинського «WO-»', () => {
    const r = parsePurpose('Оплата за нарядом WO-123');
    expect(r.workOrderNumber).toBe('123');
  });

  it('витягує номер наряду з «WO 45» (пробіл)', () => {
    expect(parsePurpose('Payment WO 45').workOrderNumber).toBe('45');
  });

  it('витягує номер наряду з українського «наряд №»', () => {
    const r = parsePurpose('Оплата наряд № 789 без рахунку тексту');
    expect(r.workOrderNumber).toBe('789');
  });

  it('hint=PREPAYMENT для «аванс»/«передоплата»', () => {
    expect(parsePurpose('Аванс за ремонт').hint).toBe('PREPAYMENT');
    expect(parsePurpose('Передоплата 50%').hint).toBe('PREPAYMENT');
  });

  it('hint=REFUND для «повернення»/«возврат»', () => {
    expect(parsePurpose('Повернення коштів').hint).toBe('REFUND');
    expect(parsePurpose('Возврат помилкового платежу').hint).toBe('REFUND');
  });

  it('порожній / невалідний вхід → усі поля undefined', () => {
    expect(parsePurpose('')).toEqual({});
    expect(parsePurpose('   ')).toEqual({});
    expect(parsePurpose(null)).toEqual({});
    expect(parsePurpose(undefined)).toEqual({});
  });

  it('текст без номерів і ключових слів → порожній результат', () => {
    expect(parsePurpose('Просто переказ коштів')).toEqual({});
  });

  it('WO має пріоритет над українським «наряд» коли обидва можливі', () => {
    const r = parsePurpose('наряд WO-999');
    expect(r.workOrderNumber).toBe('999');
  });

  it('поєднання: рахунок + аванс', () => {
    const r = parsePurpose('Аванс за рахунком №777');
    expect(r.invoiceNumber).toBe('777');
    expect(r.hint).toBe('PREPAYMENT');
  });
});
