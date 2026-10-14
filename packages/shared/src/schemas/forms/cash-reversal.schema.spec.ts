/**
 * Тіло сторно касової операції (BR-CASH-023): причина обов'язкова, до 500 символів, і саме вона
 * стає приміткою рядка сторно. Одна схема для картки на web і для маршруту api.
 *
 * Очікування — з тексту правила в дос'є (`docs/objects/cash.md`), не з коду схеми: «обов'язкова»
 * означає, що порожній рядок і рядок із самих пробілів відхиляються; «до 500» — що 500 ще можна,
 * 501 уже ні; ліміт рахується по ОБРІЗАНІЙ причині (пробіли довкола не з'їдають місце).
 */
import { describe, it, expect } from 'vitest';
import { cashReversalSchema } from './cash-operation.schema';

/** Ключ першої помилки поля `reason` (або null, якщо схема прийняла). */
function reasonError(input: unknown): string | null {
  const parsed = cashReversalSchema.safeParse(input);
  if (parsed.success) return null;
  const issue = parsed.error.issues.find(i => i.path[0] === 'reason');
  return issue?.message ?? parsed.error.issues[0]?.message ?? 'unknown';
}

describe('cashReversalSchema — причина сторно', () => {
  // guards: BR-CASH-023
  it('звичайна причина проходить; пробіли довкола обрізаються — у примітку йде чистий текст', () => {
    const parsed = cashReversalSchema.safeParse({ reason: '  помилка касира: не та сума  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe('помилка касира: не та сума');
  });

  // guards: BR-CASH-023
  it.each([
    ['порожній рядок', { reason: '' }],
    ['лише пробіли', { reason: '     ' }],
    ['лише табуляції й переноси', { reason: '\t\n  \n' }],
    ['поля немає', {}],
    ['null', { reason: null }],
    ['не рядок (число)', { reason: 42 }],
  ])('%s → «Вкажіть причину сторно»', (_n, input) => {
    expect(reasonError(input)).toBe('v.cashReversal.reason.required');
  });

  // guards: BR-CASH-023
  it('рівно 500 символів — ще можна', () => {
    expect(reasonError({ reason: 'я'.repeat(500) })).toBeNull();
  });

  // guards: BR-CASH-023
  it('501 символ → «Причина задовга (до 500 символів)»', () => {
    expect(reasonError({ reason: 'я'.repeat(501) })).toBe('v.cashReversal.reason.max');
  });

  // guards: BR-CASH-023
  it('500 символів тексту з пробілами довкола — проходить: ліміт рахується після обрізання', () => {
    expect(reasonError({ reason: `   ${'я'.repeat(500)}   ` })).toBeNull();
  });

  // guards: BR-CASH-023
  it('зайві поля тіла (сума, напрям) схема не переносить у результат — сторно бере їх з оригіналу', () => {
    const parsed = cashReversalSchema.safeParse({ reason: 'дубль', amount: 1, direction: 'OUT' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ reason: 'дубль' });
  });
});
