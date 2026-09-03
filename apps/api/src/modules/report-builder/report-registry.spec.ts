import { describe, it, expect } from 'vitest';
import { REGISTRY, REGISTRY_ENUMS, getEntity } from './report-registry';
import { buildQuery } from './report-query.builder';

/**
 * Реєстр-цілісність. Ключове: hasSoftDelete прапорець МАЄ збігатися з реальною наявністю
 * `deletedAt` у Prisma-моделі — інакше білдер інжектить `deletedAt:null` у сутність без цього
 * поля → PrismaClientValidation"Unknown argument deletedAt" (реальний баг stockBatch).
 * Список append-only (без deletedAt) звірено зі schema.prisma.
 */
const APPEND_ONLY = new Set(['payment', 'settlementTransaction', 'stockMovement', 'stockBatch']);

describe('report-registry цілісність', () => {
  const ORG = 'org-1';

  it('усі 9 сутностей присутні', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        'invoice',
        'payment',
        'purchaseOrderLine',
        'settlementTransaction',
        'stockBatch',
        'stockItem',
        'stockMovement',
        'workOrder',
        'workOrderPart',
      ].sort(),
    );
  });

  it('hasSoftDelete узгоджений з profile (APPEND_ONLY → hasSoftDelete:false)', () => {
    for (const [key, e] of Object.entries(REGISTRY)) {
      if (APPEND_ONLY.has(key)) {
        expect(e.profile, `${key} має бути APPEND_ONLY`).toBe('APPEND_ONLY');
        expect(e.hasSoftDelete, `${key} НЕ має мати deletedAt-інжекцію`).toBe(false);
      } else {
        expect(e.profile, `${key} має бути FULL`).toBe('FULL');
        expect(e.hasSoftDelete, `${key} має soft-delete`).toBe(true);
      }
    }
  });

  it('append-only сутність: buildQuery НЕ інжектить deletedAt у корінь', () => {
    for (const key of APPEND_ONLY) {
      const q = buildQuery({ entity: key, columns: [], groupBy: [] }, ORG);
      expect(q.args.where).toMatchObject({ orgId: ORG });
      expect((q.args.where as Record<string, unknown>).deletedAt).toBeUndefined();
    }
  });

  it('FULL сутність: buildQuery інжектить deletedAt:null', () => {
    const q = buildQuery({ entity: 'invoice', columns: [], groupBy: [] }, ORG);
    expect(q.args.where).toMatchObject({ orgId: ORG, deletedAt: null });
  });

  it('кожне enum-поле посилається на наявний REGISTRY_ENUMS', () => {
    for (const e of Object.values(REGISTRY)) {
      for (const f of e.fields) {
        if (f.type === 'enum') {
          expect(f.enumName, `${e.key}.${f.key} enum`).toBeDefined();
          expect(
            REGISTRY_ENUMS[f.enumName!],
            `${f.enumName} має бути у REGISTRY_ENUMS`,
          ).toBeDefined();
        }
      }
    }
  });

  it('кожен relation-field prismaPath має валідний relation-prefix', () => {
    for (const e of Object.values(REGISTRY)) {
      for (const f of e.fields) {
        if (f.prismaPath.includes('.')) {
          // не кидає — prefix присутній у relations[]
          expect(() =>
            buildQuery({ entity: e.key, columns: [f.key], groupBy: [] }, ORG),
          ).not.toThrow();
        }
      }
    }
  });

  it('signedByType поле посилається на сусіднє enum-поле (StockMovement.quantity → type)', () => {
    const sm = getEntity('stockMovement');
    const qty = sm.fields.find(f => f.key === 'quantity')!;
    expect(qty.signedByType).toBe('type');
    expect(sm.fields.some(f => f.key === qty.signedByType)).toBe(true);
  });
});
