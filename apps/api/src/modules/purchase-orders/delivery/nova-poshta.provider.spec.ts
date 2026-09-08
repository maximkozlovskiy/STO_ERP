import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliveryStatus } from '@prisma/client';
import { NovaPoshtaProvider } from './nova-poshta.provider';
import type { NovaPoshtaClient } from './nova-poshta.client';
import type { DeliveryConfig } from './delivery-provider.interface';

/**
 * Мапінг StatusCode Нової Пошти → DeliveryStatus (звірено з офіційним довідником
 * TrackingDocument.getStatusDocuments). Guard: термінальні коди (2/3/9/10/11/102/103/105/106)
 * МУСЯТЬ давати термінальний DeliveryStatus, інакше nova-poshta-polling опитує НП нескінченно.
 *
 * Регресія: 102 (відмова відправника) і 106 (зворотна доставка) раніше падали у default→IN_TRANSIT.
 */
const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'DELIVERED',
  'RETURNED',
  'NOT_FOUND',
]);

describe('NovaPoshtaProvider.mapStatus (через getStatus)', () => {
  let provider: NovaPoshtaProvider;
  let client: { getStatusDocument: ReturnType<typeof vi.fn> };
  const cfg: DeliveryConfig = {
    apiUrl: null,
    credentials: { apiKey: 'test-key' },
  } as unknown as DeliveryConfig;

  beforeEach(() => {
    client = { getStatusDocument: vi.fn() };
    provider = new NovaPoshtaProvider(client as unknown as NovaPoshtaClient);
  });

  const expectMap = async (statusCode: string, expected: DeliveryStatus) => {
    client.getStatusDocument.mockResolvedValue({ statusCode, status: `raw-${statusCode}` });
    const res = await provider.getStatus(cfg, 'EN1');
    expect(res.status).toBe(expected);
    expect(res.raw).toBe(`raw-${statusCode}`);
  };

  it('1 → PENDING (створено, очікує)', () => expectMap('1', 'PENDING'));
  it('2 → RETURNED (видалено, термінальний)', () => expectMap('2', 'RETURNED'));
  it('3 → NOT_FOUND (не знайдено, термінальний)', () => expectMap('3', 'NOT_FOUND'));

  it.each(['7', '8'])('%s → ARRIVED (прибув на відділення/поштомат)', code =>
    expectMap(code, 'ARRIVED'),
  );

  it.each(['9', '10', '11'])('%s → DELIVERED (отримано/платіж)', code =>
    expectMap(code, 'DELIVERED'),
  );

  // Ключова регресія цього фіксу: 102/106 — термінальні, не IN_TRANSIT.
  it.each(['102', '103', '105', '106'])('%s → RETURNED (відмова/повернення, термінальний)', code =>
    expectMap(code, 'RETURNED'),
  );

  it.each(['4', '5', '6', '12', '41', '101', '104', '111', '112'])(
    '%s → IN_TRANSIT (проміжний / повторна спроба)',
    code => expectMap(code, 'IN_TRANSIT'),
  );

  it('невідомий код → IN_TRANSIT (не термінальний, продовжуємо опитувати)', () =>
    expectMap('9999', 'IN_TRANSIT'));

  // Інваріант термінальності: КОЖЕН термінальний код НП → DeliveryStatus ∈ TERMINAL-множина
  // (інакше polling не зупиниться). Дзеркалить TERMINAL у nova-poshta-polling.processor.ts.
  it.each(['2', '3', '9', '10', '11', '102', '103', '105', '106'])(
    'термінальний код %s → термінальний DeliveryStatus (зупиняє self-poll)',
    async code => {
      client.getStatusDocument.mockResolvedValue({ statusCode: code, status: 'x' });
      const res = await provider.getStatus(cfg, 'EN1');
      expect(TERMINAL.has(res.status)).toBe(true);
    },
  );
});
