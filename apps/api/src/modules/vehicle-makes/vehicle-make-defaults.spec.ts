import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { vehicleNameKey } from '@sto/shared';
import { DEFAULT_VEHICLE_MAKES } from './vehicle-make-defaults';

/**
 * Стартовий список марок живе у двох місцях: `vehicle-make-defaults.ts` (сіє `SetupService` для
 * нової організації) і SQL міграції `20261023180000_vehicle_makes_and_models` (наявні організації
 * й зведення старого вільного тексту за аліасами). Сторож розбирає SQL і звіряє обидва списки.
 */
const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'database',
  'prisma',
  'migrations',
  '20261023180000_vehicle_makes_and_models',
  'migration.sql',
);

/** Рядки-кортежі з `INSERT INTO "<table>" (...) VALUES (...), (...);` — значення в лапках. */
function insertedTuples(sql: string, table: string): string[][] {
  const start = sql.indexOf(`INSERT INTO "${table}"`);
  if (start < 0) throw new Error(`У міграції немає INSERT INTO "${table}"`);
  const end = sql.indexOf(';', start);
  const body = sql.slice(sql.indexOf('VALUES', start), end);
  return Array.from(body.matchAll(/\(([^)]*)\)/g)).map(m =>
    Array.from(m[1].matchAll(/'((?:[^']|'')*)'/g)).map(v => v[1].replace(/''/g, "'")),
  );
}

describe('Стартовий список марок: код ↔ міграція (BR-VEH-012)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  // guards: BR-VEH-012
  it('марки в міграції — ті самі й у тому самому порядку, що й у коді', () => {
    const fromSql = insertedTuples(sql, '_vm_default').map(([name]) => name);
    expect(fromSql.length).toBeGreaterThan(40);
    expect(fromSql).toEqual(DEFAULT_VEHICLE_MAKES.map(m => m.name));
  });

  // guards: BR-VEH-012
  it('аліаси в міграції — ті самі пари «написання → марка», що й у коді', () => {
    const fromSql = insertedTuples(sql, '_vm_alias').map(([alias, name]) => `${alias} → ${name}`);
    const fromCode = DEFAULT_VEHICLE_MAKES.flatMap(m =>
      (m.aliases ?? []).map(alias => `${alias} → ${m.name}`),
    );
    expect(fromSql).toEqual(fromCode);
  });

  it('ключі назв і аліасів не перетинаються: одне написання — одна марка', () => {
    const keys = DEFAULT_VEHICLE_MAKES.flatMap(m => [m.name, ...(m.aliases ?? [])]).map(
      vehicleNameKey,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
