import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * СТАТИЧНИЙ сторож правила «залишки змінює лише `InventoryService.createMovement()`».
 *
 * Unit-спеки мокають Prisma, тож прямий `tx.stockItem.update(...)` у чужому сервісі пройшов би
 * їх зеленим: рух не записано, партії не списано, guard `available` не спрацював. Тому правило
 * стережеться по ВИХІДНОМУ коду api: кожен виклик запису в складські моделі мусить стояти у
 * переліку нижче. Новий запис (навіть усередині модуля inventory) червонить тест — це
 * навмисно: перелік дописується свідомо, з поясненням, чому запис не обходить createMovement.
 */

const SRC_DIR = join(__dirname, '..', '..');

const STOCK_MODELS = ['stockItem', 'stockMovement', 'stockBatch', 'batchConsumption'];
const WRITE_OPS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

/** Єдині дозволені записи: `<шлях від src>::<модель>.<операція>`. */
const ALLOWED_WRITES = new Set<string>([
  // createMovement: рух + агрегат залишку + одноразове трасування batchId
  'modules/inventory/inventory.service.ts::stockMovement.create',
  'modules/inventory/inventory.service.ts::stockItem.upsert',
  'modules/inventory/inventory.service.ts::stockMovement.update',
  // updateMinStock: лише поріг `minStock`, кількість і резерв не чіпає
  'modules/inventory/inventory.service.ts::stockItem.updateMany',
  // BatchService — викликається лише з createMovement (createFromReceipt/consumeBatch/returnToBatch)
  'modules/inventory/batch.service.ts::stockBatch.create',
  'modules/inventory/batch.service.ts::stockBatch.updateMany',
  'modules/inventory/batch.service.ts::batchConsumption.create',
]);

const STOCK_TABLES = ['stock_items', 'stock_movements', 'stock_batches', 'batch_consumptions'];

/** Усі продукт-файли api (без спеків і фікстур). */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec-fixture.ts') &&
      !entry.endsWith('.d.ts')
    )
      out.push(full);
  }
  return out;
}

/** Код без коментарів: рядки-коментарі та хвости `// …` не мають давати хибних збігів. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

const relPath = (file: string): string => relative(SRC_DIR, file).split(sep).join('/');

const FILES = collectSourceFiles(SRC_DIR).map(file => ({
  rel: relPath(file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

function findStockWrites(): string[] {
  const re = new RegExp(
    String.raw`\b(${STOCK_MODELS.join('|')})\s*\.\s*(${WRITE_OPS.join('|')})\s*\(`,
    'g',
  );
  const found: string[] = [];
  for (const { rel, code } of FILES) {
    for (const m of code.matchAll(re)) found.push(`${rel}::${m[1]}.${m[2]}`);
  }
  return found;
}

describe('Inventory — єдина точка запису залишків (статичний сторож)', () => {
  // guards: BR-INVT-001
  it('поза переліком дозволених немає жодного Prisma-запису у stockItem/stockMovement/stockBatch/batchConsumption', () => {
    const writes = findStockWrites();
    // Сторож бачить реальний код: якщо скан нічого не знайшов — зламався сам сторож.
    expect(writes).toContain('modules/inventory/inventory.service.ts::stockItem.upsert');
    const violations = [...new Set(writes)].filter(w => !ALLOWED_WRITES.has(w));
    expect(violations).toEqual([]);
  });

  // guards: BR-INVT-001
  it('немає сирого SQL, що пише у складські таблиці (UPDATE / INSERT / DELETE)', () => {
    const re = new RegExp(
      String.raw`\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(${STOCK_TABLES.join('|')})\b`,
      'gi',
    );
    const violations: string[] = [];
    for (const { rel, code } of FILES) {
      for (const m of code.matchAll(re)) violations.push(`${rel}::${m[0]}`);
    }
    expect(violations).toEqual([]);
  });

  // SyncService пише через динамічний делегат `prisma[model]` — regex вище його не бачить.
  // Єдиний бар'єр там — список PUSH_SAFE_TABLES: складські таблиці в нього потрапити не мають.
  // guards: BR-INVT-001
  it('sync push не приймає складські таблиці (PUSH_SAFE_TABLES без stock_*/batch_*)', () => {
    const sync = FILES.find(f => f.rel === 'modules/sync/sync.service.ts');
    expect(sync).toBeDefined();
    const block = /const PUSH_SAFE_TABLES = new Set\(\[([\s\S]*?)\]\)/.exec(sync!.code);
    expect(block).not.toBeNull();
    const tables = [...block![1]!.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter(t => STOCK_TABLES.includes(t!))).toEqual([]);
  });

  // Рух append-only на рівні коду: жодного delete, а єдиний update несе лише `batchId`.
  // Фізичну незмінність тримає тригер БД (див. дос'є) — тут стережеться код.
  // guards: BR-INVT-016
  it('StockMovement у коді не видаляється, а єдиний update проставляє лише batchId', () => {
    const forbidden = findStockWrites().filter(w =>
      /::stockMovement\.(delete|deleteMany|updateMany|upsert)$/.test(w),
    );
    expect(forbidden).toEqual([]);

    const updates: string[] = [];
    for (const { code } of FILES) {
      for (const m of code.matchAll(/\bstockMovement\s*\.\s*update\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
        updates.push(m[1]!);
      }
    }
    expect(updates).toHaveLength(1);
    const data = /data:\s*\{([^}]*)\}/.exec(updates[0]!);
    expect(data).not.toBeNull();
    const keys = data![1]!
      .split(',')
      .map(part => part.split(':')[0]!.trim())
      .filter(Boolean);
    expect(keys).toEqual(['batchId']);
  });
});
