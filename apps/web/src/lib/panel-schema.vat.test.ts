// Detail Panel наряду (schema-driven): поля «Сума без ПДВ» і «ПДВ» приходять зі схеми і
// заповнюються лише коли ПДВ у сумі є (BR-WO-007).
//
// Mutation-verify (прогнано): `workOrderVatSplit` завжди повертає ненульовий ПДВ → кейси
// «ПДВ немає» і «наряд до 2026-10-08» падають.
import { describe, it, expect } from 'vitest';
import type { WorkOrder } from '@/hooks/api/useWorkOrders';
import {
  WORK_ORDER_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from './panel-schema';

const norm = (v: unknown) => String(v).replace(/\s/g, ' ');
const config = { hiddenFields: [], fieldOrder: [] };

const wo = (over: Partial<WorkOrder>): WorkOrder =>
  ({ totalAmount: 0, totalNet: 0, totalVat: 0, ...over }) as WorkOrder;

const field = (record: WorkOrder, key: string) =>
  buildPanelFields(record, WORK_ORDER_PANEL_SCHEMA, config).find(f => f.key === key);

// guards: BR-WO-007
describe('WORK_ORDER_PANEL_SCHEMA — ПДВ у сумі наряду', () => {
  it('схема містить «Сума», «Сума без ПДВ», «ПДВ» поруч', () => {
    const keys = WORK_ORDER_PANEL_SCHEMA.map(f => f.key);
    const i = keys.indexOf('totalAmount');
    expect(keys.slice(i, i + 3)).toEqual(['totalAmount', 'totalNet', 'totalVat']);
    expect(WORK_ORDER_PANEL_SCHEMA.find(f => f.key === 'totalNet')?.label).toBe('Сума без ПДВ');
    expect(WORK_ORDER_PANEL_SCHEMA.find(f => f.key === 'totalVat')?.label).toBe('ПДВ');
  });

  it('ПДВ є: сума з ПДВ, сума без ПДВ і ПДВ як різниця', () => {
    const record = wo({ totalAmount: 1440, totalNet: 1200, totalVat: 240 });
    expect(norm(field(record, 'totalAmount')?.value)).toBe('1 440,00 ₴');
    expect(norm(field(record, 'totalNet')?.value)).toBe('1 200,00 ₴');
    expect(norm(field(record, 'totalVat')?.value)).toBe('240,00 ₴');
  });

  it('ПДВ немає: поля розкладки порожні, сума лишається', () => {
    const record = wo({ totalAmount: 1200, totalNet: 1200, totalVat: 0 });
    expect(norm(field(record, 'totalAmount')?.value)).toBe('1 200,00 ₴');
    expect(field(record, 'totalNet')?.value).toBeUndefined();
    expect(field(record, 'totalVat')?.value).toBeUndefined();
  });

  it('наряд до 2026-10-08: totalVat ненульовий, але totalNet = totalAmount → ПДВ не показано', () => {
    const record = wo({ totalAmount: 1200, totalNet: 1200, totalVat: 200 });
    expect(field(record, 'totalVat')?.value).toBeUndefined();
    expect(field(record, 'totalNet')?.value).toBeUndefined();
  });

  it('налаштування полів панелі будується з порожнього запису без помилки', () => {
    const fields = schemaToPanelConfigFields(WORK_ORDER_PANEL_SCHEMA, config);
    expect(fields.map(f => f.key)).toContain('totalNet');
    expect(fields.map(f => f.key)).toContain('totalVat');
  });
});
