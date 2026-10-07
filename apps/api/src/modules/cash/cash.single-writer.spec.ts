/**
 * СТАТИЧНИЙ сторож «єдиного писаря» каси (BR-CASH-001, BR-CASH-002).
 *
 * Готівку рухає ЛИШЕ `CashService.createOperation()`, і журнал `CashOperation` лише
 * дописується. Unit-спеки мокають Prisma, тож прямий `cashOperation.create(…)` у чужому сервісі
 * (оплата, що оминула overdraft-guard і перевірку зміни) або `cashOperation.update(…)` жоден із
 * них не помітить. Тому правило стережеться по ВИХІДНОМУ коду — читаємо всі `*.ts` у
 * `apps/api/src` (крім спеків і фікстур) і порівнюємо знайдені записи з точним переліком.
 * Шаблон — `settlements.single-writer.spec.ts`.
 *
 * Сторож свідомо НЕ вирізає коментарі: згадка `cashOperation.update(` у коментарі дасть хибне
 * спрацювання, але це дешевше за пропущене справжнє (fail-closed).
 *
 * Чого він не бачить: запис через змінну-делегат (`const d = tx.cashOperation; d.update(…)`)
 * і вкладений запис через зв'язок з іншого боку, крім прямого `operations: { create|… }`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = join(__dirname, '..', '..');

const WRITE_OPS =
  'create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany';

// tx.cashOperation.create( … ) — у т.ч. з переносом рядка перед `.create`
const DELEGATE_WRITE = new RegExp(`\\b(cashOperation)\\s*\\.\\s*(${WRITE_OPS})\\b`, 'g');
// cashRegister.update({ data: { operations: { create: … } } })
const NESTED_WRITE =
  /\boperations\s*:\s*\{\s*(create|createMany|connectOrCreate|update|updateMany|upsert|delete|deleteMany)\b/g;
// $executeRaw`UPDATE cash_operations SET …`
const RAW_WRITE = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(cash_operations)\b/gi;

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

/** Усі записи в журнал каси: `<шлях від src>::<модель>.<операція>`. */
function findCashWrites(): string[] {
  const hits: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    const where = relative(SRC_DIR, file).split('\\').join('/');
    for (const m of source.matchAll(DELEGATE_WRITE)) hits.push(`${where}::${m[1]}.${m[2]}`);
    for (const m of source.matchAll(NESTED_WRITE)) hits.push(`${where}::nested operations.${m[1]}`);
    for (const m of source.matchAll(RAW_WRITE))
      hits.push(`${where}::raw ${m[1].toUpperCase()} ${m[2]}`);
  }
  return hits.sort();
}

describe('Cash — єдиний писар руху готівки (статичний сторож)', () => {
  // guards: BR-CASH-001
  it('у CashOperation пише лише CashService.createOperation — один create на весь api', () => {
    expect(findCashWrites()).toEqual(['modules/cash/cash.service.ts::cashOperation.create']);
  });

  // guards: BR-CASH-002
  it('журнал append-only: у коді api немає зміни чи видалення CashOperation', () => {
    const mutations = findCashWrites().filter(h => !/::cashOperation\.create$/.test(h));
    expect(mutations).toEqual([]);
  });

  // Сторож, що нічого не знаходить, зеленіє завжди — переконуємось, що обхід справді дійшов до
  // модулів-викликачів каси, а не зупинився на порожній теці.
  it('сторож справді обходить код: файлів сотні, серед них викликачі каси', () => {
    const files = collectSourceFiles(SRC_DIR).map(f => relative(SRC_DIR, f).split('\\').join('/'));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('modules/payments/payments.service.ts');
    expect(files).toContain('modules/payroll/payroll.service.ts');
    expect(files).toContain('modules/supplier-payments/supplier-payments.service.ts');
  });
});
