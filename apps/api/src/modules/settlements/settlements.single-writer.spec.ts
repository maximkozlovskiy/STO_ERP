/**
 * СТАТИЧНИЙ сторож «єдиного писаря» взаєморозрахунків (BR-SETL-001, BR-SETL-009).
 *
 * Баланс контрагента і журнал транзакцій змінює ЛИШЕ `SettlementsService.createTransaction()`.
 * Unit-спеки мокають Prisma, тож прямий `settlementAccount.update({ balance })` десь у чужому
 * сервісі жоден із них не помітить: баланс розійдеться з журналом мовчки, і це знайде хіба
 * нічна звірка. Тому правило стережеться по ВИХІДНОМУ коду — читаємо всі `*.ts` у `apps/api/src`
 * (крім спеків і фікстур) і порівнюємо знайдені записи з точним переліком дозволених.
 *
 * Сторож свідомо НЕ вирізає коментарі: згадка `settlementAccount.update(` у коментарі дасть
 * хибне спрацювання, але це дешевше за пропущене справжнє (fail-closed).
 *
 * Чого він не бачить: вкладені записи через зв'язок з іншої моделі, крім прямого
 * `settlementAccount: { create|update|… }` (напр. `transactions: { create: … }`), і запис через
 * змінну-делегат (`const d = tx.settlementAccount; d.update(…)`).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = join(__dirname, '..', '..');

const WRITE_OPS =
  'create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany';

// tx.settlementAccount.update( … ) — у т.ч. з переносом рядка перед `.update`
const DELEGATE_WRITE = new RegExp(
  `\\b(settlementAccount|settlementTransaction)\\s*\\.\\s*(${WRITE_OPS})\\b`,
  'g',
);
// counterparty.update({ data: { settlementAccount: { update: { balance … } } } })
const NESTED_WRITE =
  /\bsettlementAccount\s*:\s*\{\s*(create|connectOrCreate|update|updateMany|upsert|delete|deleteMany)\b/g;
// $executeRaw`UPDATE settlement_accounts SET balance = …`
const RAW_WRITE =
  /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(settlement_accounts|settlement_transactions)\b/gi;

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

/** Усі записи в моделі взаєморозрахунків: `<шлях від src>::<модель>.<операція>`. */
function findSettlementWrites(): string[] {
  const hits: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    const where = relative(SRC_DIR, file).split('\\').join('/');
    for (const m of source.matchAll(DELEGATE_WRITE)) hits.push(`${where}::${m[1]}.${m[2]}`);
    for (const m of source.matchAll(NESTED_WRITE))
      hits.push(`${where}::nested settlementAccount.${m[1]}`);
    for (const m of source.matchAll(RAW_WRITE))
      hits.push(`${where}::raw ${m[1].toUpperCase()} ${m[2]}`);
  }
  return hits.sort();
}

describe('Settlements — єдиний писар балансу (статичний сторож)', () => {
  // guards: BR-SETL-001
  it('у SettlementAccount і SettlementTransaction пише лише createTransaction; рахунок створює лише CounterpartiesService.create', () => {
    expect(findSettlementWrites()).toEqual([
      // BR-CP-012: рахунок із нульовим балансом народжується разом із контрагентом
      'modules/counterparties/counterparties.service.ts::settlementAccount.create',
      // createTransaction: одна зміна балансу + один рядок журналу
      'modules/settlements/settlements.service.ts::settlementAccount.update',
      'modules/settlements/settlements.service.ts::settlementTransaction.create',
    ]);
  });

  // guards: BR-SETL-009
  it('журнал append-only: у коді api немає зміни чи видалення SettlementTransaction', () => {
    const mutations = findSettlementWrites().filter(
      h => /settlementTransaction\.(?!create$)/.test(h) || /settlement_transactions$/.test(h),
    );
    expect(mutations).toEqual([]);
  });

  // Сторож, що нічого не знаходить, зеленіє завжди — переконуємось, що обхід справді дійшов до
  // чужих модулів, а не зупинився на порожній теці.
  it('сторож справді обходить код: файлів сотні, серед них сервіси інших модулів', () => {
    const files = collectSourceFiles(SRC_DIR).map(f => relative(SRC_DIR, f).split('\\').join('/'));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('modules/work-orders/work-order-stock-effects.service.ts');
    expect(files).toContain('modules/payments/payments.service.ts');
  });
});
