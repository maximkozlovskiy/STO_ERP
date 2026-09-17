import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_EXEMPT_MODELS } from './tenant-guard.extension';

/**
 * СТАТИЧНИЙ guard проти класу багів «prisma.X.update/delete({ where: { id } })» БЕЗ orgId/branchId.
 *
 * Контекст (3 реальні інциденти: report-builder updateSaved, auth.changePassword, і мало не
 * optimize-рефактори): A1 fail-closed tenant-guard ($extends) кидає TenantIsolationError на будь-який
 * guarded update/delete, чий `where` не несе tenant-токена → замаскований HTTP 500. АЛЕ:
 *   • unit-специ МОКАЮТЬ Prisma → guard-extension НЕ виконується → баг проходить тести зелено;
 *   • ловиться лише коли хтось реально пройде цей шлях (E2E / жива перевірка / прод).
 *
 * Цей тест ловить патерн СТАТИЧНО — у ВИХІДНОМУ коді сервісів, ще до рантайму — тож регресія
 * червоніє на першому ж написанні, байдуже людиною чи агентом-оптимізатором. Доповнює
 * tenant-guard.integration.spec (рантайм) статичним CI-детектором.
 *
 * ⚠️ Правило: write-операція завжди несе orgId (або branchId/composite-unique) у where. Якщо модель
 * легітимно tenant-exempt (junction / Organisation / append-only-child) — додати у ALLOWLIST нижче
 * з коментарем-обґрунтуванням, дзеркалячи TENANT_EXEMPT_MODELS у tenant-guard.extension.ts.
 */

const MODULES_DIR = join(__dirname, '..', 'modules');

// Точкові винятки: `<delegate>.<op>` виклики, де where:{id} без orgId дозволено (модель exempt
// або tenant досягається інакше). Формат: 'delegate.operation' або лишити коментар чому.
const ALLOWLIST = new Set<string>([
  // self-tenant root — orgId === id, читається/пишеться за where:{id}
  'organisation.update',
  'organisation.updateMany',
  // junction/child таблиці з TENANT_EXEMPT_MODELS (tenant через parent FK / composite PK)
  'pricingRuleTier.update',
  'pricingRuleTier.updateMany',
  'pricingRuleTier.delete',
  'pricingRuleTier.deleteMany',
  // DeadLetterJob — TENANT_EXEMPT (nullable orgId, infra). resolve() робить findFirst({id,orgId})
  // orgId-гейт ПЕРЕД update({where:{id}}) → крос-tenant запис неможливий.
  'deadLetterJob.update',
]);

/** Рекурсивно зібрати всі *.service.ts (без *.spec.ts). */
function collectServiceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectServiceFiles(full));
    else if (entry.endsWith('.service.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * Знайти виклики <delegate>.(update|updateMany|delete|deleteMany)({ where: { ... } }) де перший
 * ключ у where — `id` (або `id_...`) і у тому ж where-обʼєкті НЕ згадується orgId/branchId.
 * Простий, але надійний евристичний парсер: беремо текст від `.op({ where: {` до збалансованої `}`.
 */
function findUnscopedWrites(source: string): { delegate: string; op: string; snippet: string }[] {
  const hits: { delegate: string; op: string; snippet: string }[] = [];
  const re = /(\w+)\.(update|updateMany|delete|deleteMany)\(\s*\{\s*where:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const delegate = m[1];
    const op = m[2];
    // Витягнути тіло where {...} (збалансовані дужки від позиції відкриття).
    const start = re.lastIndex - 1; // на відкривній `{` where-обʼєкта
    let depth = 0;
    let i = start;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const whereBody = source.slice(start, i + 1);
    // Перший ключ where — id? (id: ... або id_... composite)
    const firstKeyIsId = /^\{\s*id[,:}\s_]/.test(whereBody);
    const hasTenant = /\borgId\b|\bbranchId\b/.test(whereBody);
    if (firstKeyIsId && !hasTenant && !ALLOWLIST.has(`${delegate}.${op}`)) {
      hits.push({ delegate, op, snippet: whereBody.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return hits;
}

describe('tenant-guard STATIC — write без orgId у where (клас багів #747/updateSaved/changePassword)', () => {
  it('жоден сервіс не робить update/delete({where:{id}}) без orgId/branchId', () => {
    const files = collectServiceFiles(MODULES_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity: знайшли сервіси

    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const h of findUnscopedWrites(src)) {
        const rel = f.slice(f.indexOf('modules'));
        violations.push(`  ${rel}: ${h.delegate}.${h.op}({ where: ${h.snippet} })`);
      }
    }

    expect(
      violations,
      'A1 tenant-guard кине TenantIsolationError (HTTP 500) на цих guarded-write без tenant-токена ' +
        'у where. Додай orgId (де: { id, orgId }), АБО — якщо модель легітимно exempt — у ALLOWLIST ' +
        'з обґрунтуванням.\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  // Drift-guard: ALLOWLIST не має «прикривати» модель, яка НЕ exempt у рантаймі — інакше статичний
  // пас видавав би зелене там, де guard реально кине 500. Кожен delegate у ALLOWLIST мусить мапитись
  // на модель із TENANT_EXEMPT_MODELS (delegate camelCase → Model PascalCase).
  it('кожен ALLOWLIST-запис відповідає моделі з рантайм-TENANT_EXEMPT_MODELS (без дрейфу)', () => {
    const exemptCamel = new Set(
      [...TENANT_EXEMPT_MODELS].map(m => m[0].toLowerCase() + m.slice(1)),
    );
    const bogus = [...ALLOWLIST]
      .map(entry => entry.split('.')[0])
      .filter(delegate => !exemptCamel.has(delegate));
    expect(
      bogus,
      'Ці ALLOWLIST-моделі НЕ у TENANT_EXEMPT_MODELS (tenant-guard.extension.ts) → статичний пас ' +
        'приховав би реальний runtime-500. Прибери з ALLOWLIST або додай у TENANT_EXEMPT_MODELS.',
    ).toEqual([]);
  });
});
