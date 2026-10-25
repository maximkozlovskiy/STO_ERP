import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { $Enums } from '@prisma/client';
import { REGISTRY, REGISTRY_ENUMS, getEntity, isDateOnlyPath } from './report-registry';
import type { ReportFieldDef } from './report-registry';
import { buildQuery } from './report-query.builder';
import { resolveJoins } from './report-joins';

/** Моделі схеми Prisma: модель → (поле → тип із `?`/`[]`). */
function schemaModels(): Map<string, Map<string, string>> {
  const schemaDir = join(__dirname, '../../../../../packages/database/prisma/schema');
  const schema = readdirSync(schemaDir)
    .filter(f => f.endsWith('.prisma'))
    .map(f => readFileSync(join(schemaDir, f), 'utf8'))
    .join('\n');
  const models = new Map<string, Map<string, string>>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, string>();
    for (const line of m[2].split('\n')) {
      const f = /^\s*(\w+)\s+([\w?[\]]+)/.exec(line);
      if (f && !line.trim().startsWith('//') && !line.trim().startsWith('@@'))
        fields.set(f[1], f[2]);
    }
    models.set(m[1], fields);
  }
  return models;
}

/** Значення для `eq`, яке приймає поле свого типу. */
function sampleValue(f: ReportFieldDef): unknown {
  if (f.enumName) return REGISTRY_ENUMS[f.enumName][0];
  if (f.type === 'number' || f.type === 'decimal') return '1';
  if (f.type === 'date') return '2026-10-01';
  if (f.type === 'boolean') return 'true';
  return 'x';
}

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

  // «Порожнє / заповнене» на обов'язковій колонці Prisma відхиляла загальною 400 «Некоректні дані
  // запиту»; тепер — 400 з назвою поля, а UI ці оператори такому полю не пропонує. Прапорець
  // звіряється зі схемою, щоб нове поле не забули позначити. Мутація: прибрати nullable(...) з
  // payment.reversedAt → кейс червоніє.
  // guards: BR-RPT-024
  it("nullable стоїть рівно на полях, колонка яких у схемі необов'язкова (`?`)", () => {
    const models = schemaModels();
    for (const e of Object.values(REGISTRY)) {
      for (const f of e.fields) {
        const segments = f.prismaPath.split('.');
        let model = e.prismaModel.charAt(0).toUpperCase() + e.prismaModel.slice(1);
        for (const seg of segments.slice(0, -1)) {
          model = (models.get(model)?.get(seg) ?? '').replace(/[?[\]]/g, '');
        }
        const type = models.get(model)?.get(segments[segments.length - 1]);
        expect(type, `${e.key}.${f.key}`).toBeDefined();
        expect(f.nullable === true, `${e.key}.${f.key} (${type})`).toBe(type!.endsWith('?'));
      }
    }
  });

  // SQL-агрегати з'єднують таблиці за FK з реєстру (Prisma 7 runtime-DMMF FK не дає). Помилкова FK
  // мовчки дала б порожні групи — тут вона падає. Мутація: fk 'accountId' у settlementTransaction.
  // guards: BR-RPT-027
  it("кожен зв'язок реєстру резолвиться в з'єднання: FK є колонкою батька, таблиця кореня — tableName", () => {
    for (const e of Object.values(REGISTRY)) {
      const joins = resolveJoins(e);
      expect(joins.rootTable, e.key).toBe(e.tableName);
      expect([...joins.hops.keys()].sort(), e.key).toEqual(
        e.relations.map(r => r.prismaPath).sort(),
      );
    }
  });

  // «Порожнє» по полю за зв'язком охоплює рядки без зв'язку лише на необов'язковому хопі (FK `?`);
  // `is: null` на обов'язковому Prisma відхиляє. Мутація: прибрати optional з good.brand → кейс червоніє.
  // guards: BR-RPT-028
  it("optional стоїть рівно на зв'язках з необов'язковою FK у схемі", () => {
    const models = schemaModels();
    for (const e of Object.values(REGISTRY)) {
      for (const r of e.relations) {
        const segments = r.prismaPath.split('.');
        let model = e.prismaModel.charAt(0).toUpperCase() + e.prismaModel.slice(1);
        for (const seg of segments.slice(0, -1)) {
          model = (models.get(model)?.get(seg) ?? '').replace(/[?[\]]/g, '');
        }
        const fkType = models.get(model)?.get(r.fk);
        expect(fkType, `${e.key}.${r.prismaPath}.${r.fk}`).toBeDefined();
        expect(r.optional, `${e.key}.${r.prismaPath} (${fkType})`).toBe(fkType!.endsWith('?'));
      }
    }
  });

  // «Сума» платежів складала різні валюти (338 221,32 у змішаних проти 352 755,32 у базовій —
  // 9 оплат у USD, dev-база 2026-10-25). Мутація: прибрати поле базової суми з payment → кейс червоніє.
  // guards: BR-RPT-029
  it('мультивалюта: сума в базовій валюті (SUM) і «Валюта» (групування) там, де є валюта', () => {
    const base: Record<string, string> = {
      payment: 'amountBase',
      settlementTransaction: 'amountBase',
      invoice: 'totalAmountBase',
    };
    for (const [key, baseField] of Object.entries(base)) {
      const e = getEntity(key);
      const f = e.fields.find(x => x.key === baseField);
      expect(f?.aggregations, `${key}.${baseField}`).toContain('SUM');
      expect(f?.label, key).toBe('Сума в базовій валюті');
      // сума у валюті документа підписана так, щоб її не сприйняли за загальну
      expect(e.fields.find(x => x.key === 'amount')?.label, key).toMatch(/у валюті/);
    }
    for (const key of [...Object.keys(base), 'workOrder']) {
      const cur = getEntity(key).fields.find(x => x.key === 'currency.code');
      expect(cur?.groupable, `${key}.currency.code`).toBe(true);
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
            filters: [
              f.nullable
                ? { field: f.key, op: 'isNull', value: true }
                : { field: f.key, op: 'eq', value: sampleValue(f) },
            ],
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
