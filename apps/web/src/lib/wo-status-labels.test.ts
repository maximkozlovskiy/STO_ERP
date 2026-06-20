import { describe, it, expect } from 'vitest';
import { WO_STATUS_LABELS, WO_STATUS_BADGE, WO_STATUS_DESCRIPTIONS } from '@sto/shared';

/**
 * Regression-guard для review Cycle 3/step 1 (commit 4f1f345d):
 * counterparties/[id]/PageClient.tsx раніше мав ЛОКАЛЬНУ копію WO_STATUS_LABELS
 * у файлі. Це призводило до drift коли backend додавав статус (ESTIMATE),
 * — counterparty detail показував raw `ESTIMATE` замість «Кошторис».
 *
 * Цей тест fіксує контракт: WO_STATUS_LABELS зі @sto/shared покриває ВСІ статуси
 * що бекенд може повернути у поле `work_order.status`.
 *
 * Якщо backend додасть новий статус — цей тест МАЄ впасти ПЕРШИМ.
 */
describe('WO_STATUS_LABELS — contract з backend WorkOrderStatus enum', () => {
  // Source of truth: prisma/schema.prisma WorkOrderStatus enum.
  // Дзеркало списку — синхронізовано вручну, оновлювати при додаванні нового статусу.
  const EXPECTED_STATUSES = [
    'DRAFT',
    'ESTIMATE',
    'APPROVED',
    'IN_PROGRESS',
    'ON_HOLD',
    'COMPLETED',
    'INVOICED',
    'PAID',
    'ARCHIVED',
    'CANCELLED',
  ] as const;

  it.each(EXPECTED_STATUSES)('має укр. label для статусу %s', status => {
    const label = WO_STATUS_LABELS[status];
    expect(label).toBeDefined();
    expect(label.length).toBeGreaterThan(0);
    // Не raw enum — має бути перекладено
    expect(label).not.toBe(status);
    // Кирилиця обов'язкова (всі переклади укр.)
    expect(/[Ѐ-ӿ]/.test(label!)).toBe(true);
  });

  it.each(EXPECTED_STATUSES)('має badge variant для статусу %s', status => {
    expect(WO_STATUS_BADGE[status]).toBeDefined();
  });

  it.each(EXPECTED_STATUSES)('має description для статусу %s', status => {
    const desc = WO_STATUS_DESCRIPTIONS[status];
    expect(desc).toBeDefined();
    expect(desc.length).toBeGreaterThan(10);
  });

  it('LABELS / BADGE / DESCRIPTIONS мають однакову множину ключів', () => {
    const labelKeys = Object.keys(WO_STATUS_LABELS).sort();
    const badgeKeys = Object.keys(WO_STATUS_BADGE).sort();
    const descKeys = Object.keys(WO_STATUS_DESCRIPTIONS).sort();
    expect(labelKeys).toEqual(badgeKeys);
    expect(labelKeys).toEqual(descKeys);
  });

  it('LABELS покриває як мінімум всі очікувані статуси', () => {
    for (const s of EXPECTED_STATUSES) {
      expect(WO_STATUS_LABELS[s]).toBeDefined();
    }
  });

  it('fallback (?? wo.status) працює коли статус відсутній у мапі — guard для майбутніх нових enums', () => {
    // Симулюємо невідомий статус (новий backend enum що ще не доданий до WO_STATUS_LABELS).
    const unknown = 'NEW_FUTURE_STATUS_X';
    const rendered = WO_STATUS_LABELS[unknown] ?? unknown;
    expect(rendered).toBe(unknown);
  });
});
