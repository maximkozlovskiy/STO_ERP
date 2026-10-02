import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsService } from './metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { Queue } from 'bullmq';

/**
 * Метрики — діагностичний інструмент для коробки в клієнта (ADR-003), тож тести
 * стережуть саме те, від чого залежить його придатність: що gauge оновлюються перед
 * віддачею і що в експорті є ключові серії.
 */
describe('MetricsService', () => {
  let service: MetricsService;
  let queue: { getJobCounts: ReturnType<typeof vi.fn> };
  let prisma: { deadLetterJob: { count: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    queue = {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 3, active: 1, delayed: 0, failed: 2 }),
    };
    prisma = { deadLetterJob: { count: vi.fn().mockResolvedValue(7) } };
    service = new MetricsService(prisma as unknown as PrismaService, queue as unknown as Queue);
  });

  it('render() віддає текст у Prometheus-форматі з нашим префіксом', async () => {
    const out = await service.render();
    expect(out).toContain('sto_http_request_duration_seconds');
    expect(out).toContain('# TYPE');
  });

  it('refresh() кладе глибину черги за станами у gauge', async () => {
    const out = await service.render();
    expect(out).toContain('sto_queue_jobs{queue="sms",state="waiting"} 3');
    expect(out).toContain('sto_queue_jobs{queue="sms",state="failed"} 2');
  });

  it("dead-letter рахується ОКРЕМО і лише нерозв'язані", async () => {
    // Це задачі, що вичерпали всі спроби — вони не спадають самі й вимагають розбору.
    const out = await service.render();
    expect(out).toContain('sto_queue_jobs{queue="dead-letter",state="unresolved"} 7');
    expect(prisma.deadLetterJob.count).toHaveBeenCalledWith({ where: { resolvedAt: null } });
  });

  it('gauge оновлюються НА КОЖЕН render (а не раз на старті)', async () => {
    await service.render();
    queue.getJobCounts.mockResolvedValueOnce({ waiting: 99, active: 0, delayed: 0, failed: 0 });
    const out = await service.render();
    expect(out).toContain('sto_queue_jobs{queue="sms",state="waiting"} 99');
  });

  it('histogram приймає спостереження і рахує їх', async () => {
    service.httpDuration.observe({ method: 'GET', route: '/api/v1/goods', status: '200' }, 0.42);
    const out = await service.render();
    expect(out).toContain('route="/api/v1/goods"');
    expect(out).toContain(
      'sto_http_request_duration_seconds_count{method="GET",route="/api/v1/goods",status="200"} 1',
    );
  });

  it('метрики процесу присутні (RSS, event-loop) — головне для mem_limit: 1g', async () => {
    const out = await service.render();
    expect(out).toContain('sto_process_resident_memory_bytes');
    expect(out).toContain('sto_nodejs_eventloop_lag_mean_seconds');
  });

  it('onModuleDestroy чистить registry (інакше інтервал тримає процес на SIGTERM)', async () => {
    service.onModuleDestroy();
    const out = await service.registry.metrics();
    // prom-client після clear() віддає порожній експорт (лише перенесення рядка) —
    // головне, що жодної серії не лишилось.
    expect(out.trim()).toBe('');
    expect(out).not.toContain('sto_');
  });
});
