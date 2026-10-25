import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { $Enums } from '@prisma/client';
import { REGISTRY, REGISTRY_ENUMS, getEntity, isDateOnlyPath } from './report-registry';
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

  // guards: BR-RPT-001
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

  // guards: BR-RPT-007
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

  // guards: BR-RPT-007
  it('append-only сутність: buildQuery НЕ інжектить deletedAt у корінь', () => {
    for (const key of APPEND_ONLY) {
      const q = buildQuery({ entity: key, columns: [], groupBy: [] }, ORG);
      expect(q.args.where).toMatchObject({ orgId: ORG });
      expect((q.args.where as Record<string, unknown>).deletedAt).toBeUndefined();
    }
  });

  // guards: BR-RPT-007
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

  // guards: BR-RPT-006
  it('кожна з 9 сутностей: orgId викликача стоїть у корені where', () => {
    for (const key of Object.keys(REGISTRY)) {
      const q = buildQuery({ entity: key, columns: [], groupBy: [] }, 'org-caller');
      expect((q.args.where as Record<string, unknown>).orgId, key).toBe('org-caller');
    }
  });

  // Перелік enum-значень реєстру відставав від схеми: рух RETURN у базі був, а фільтр по ньому
  // давав 400 (2026-10-25). Мутація: прибрати 'RETURN' з REGISTRY_ENUMS → кейс червоніє.
  // guards: BR-RPT-004
  it('REGISTRY_ENUMS збігаються зі значеннями enum-ів Prisma', () => {
    const prismaEnums = $Enums as unknown as Record<string, Record<string, string> | undefined>;
    for (const [name, values] of Object.entries(REGISTRY_ENUMS)) {
      const schemaValues = prismaEnums[name];
      expect(schemaValues, `${name} має бути enum-ом Prisma`).toBeDefined();
      expect([...values].sort(), name).toEqual(Object.values(schemaValues ?? {}).sort());
    }
  });

  // Колонка `@db.Date` без `dateOnly` зсуває період і фільтр на день назад (Prisma зводить київську
  // межу до дати) — так було з documentDate наряду й рахунку до 2026-10-25. Нова колонка
  // `@db.Date` у реєстрі без прапорця має падати тут, а не в звіті. Мутація: прибрати
  // `dateOnly: true` з invoice.documentDate → кейс червоніє.
  // guards: BR-RPT-009
  it('dateOnly стоїть рівно на колонках @db.Date схеми Prisma', () => {
    const schemaDir = join(__dirname, '../../../../../packages/database/prisma/schema');
    const schema = readdirSync(schemaDir)
      .filter(f => f.endsWith('.prisma'))
      .map(f => readFileSync(join(schemaDir, f), 'utf8'))
      .join('\n');
    const dbDateCols = new Map<string, Set<string>>();
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const cols = new Set<string>();
      for (const line of m[2].split('\n')) {
        const col = /^\s*(\w+)\s+DateTime\??\s.*@db\.Date\b/.exec(line);
        if (col) cols.add(col[1]);
      }
      dbDateCols.set(m[1], cols);
    }
    for (const e of Object.values(REGISTRY)) {
      const model = e.prismaModel.charAt(0).toUpperCase() + e.prismaModel.slice(1);
      const cols = dbDateCols.get(model);
      expect(cols, `модель ${model}`).toBeDefined();
      for (const f of e.fields.filter(x => x.type === 'date' && !x.prismaPath.includes('.'))) {
        expect(f.dateOnly === true, `${e.key}.${f.key}`).toBe(cols!.has(f.prismaPath));
      }
      expect(isDateOnlyPath(e, e.dateField), `${e.key} dateField`).toBe(cols!.has(e.dateField));
    }
  });

  // guards: BR-RPT-006, BR-RPT-007
  it('фільтр по будь-якому полю реєстру не перезаписує orgId і deletedAt кореня', () => {
    for (const e of Object.values(REGISTRY)) {
      for (const f of e.fields.filter(x => x.filterable)) {
        const where = buildQuery(
          {
            entity: e.key,
            columns: [],
            groupBy: [],
            filters: [{ field: f.key, op: 'isNull', value: true }],
          },
          ORG,
        ).args.where as Record<string, unknown>;
        expect(where.orgId, `${e.key}.${f.key} orgId`).toBe(ORG);
        expect('deletedAt' in where, `${e.key}.${f.key} deletedAt`).toBe(e.hasSoftDelete);
        if (e.hasSoftDelete) expect(where.deletedAt, `${e.key}.${f.key}`).toBeNull();
      }
    }
  });
});
