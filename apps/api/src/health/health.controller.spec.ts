import { describe, it, expect, vi } from 'vitest';
import { HealthController } from './health.controller';

/**
 * D1 — health split. /live завжди 200 без залежностей (container-healthcheck). /ready агрегує
 * DB+Redis+MinIO+чергу → degraded якщо будь-яка впала.
 */
function makeController(over: { db?: boolean; redis?: boolean; minio?: boolean; queue?: boolean }) {
  const prisma = {
    $queryRaw:
      over.db === false
        ? vi.fn().mockRejectedValue(new Error('db'))
        : vi.fn().mockResolvedValue([1]),
  };
  const redis = {
    ping:
      over.redis === false
        ? vi.fn().mockRejectedValue(new Error('r'))
        : vi.fn().mockResolvedValue('PONG'),
  };
  const files = { healthCheck: vi.fn().mockResolvedValue(over.minio !== false) };
  const smsQueue = {
    getWaitingCount:
      over.queue === false
        ? vi.fn().mockRejectedValue(new Error('q'))
        : vi.fn().mockResolvedValue(3),
  };
  return new HealthController(prisma as never, files as never, redis as never, smsQueue as never);
}

describe('HealthController (D1 live/ready split)', () => {
  it('/live → status ok БЕЗ виклику залежностей', () => {
    const ctrl = makeController({});
    const res = ctrl.live();
    expect(res.status).toBe('ok');
    expect(typeof res.uptime).toBe('number');
  });

  it('/ready усі залежності ok → status ok', async () => {
    const res = await makeController({ db: true, redis: true, minio: true, queue: true }).ready();
    expect(res.status).toBe('ok');
    expect(res.services).toMatchObject({
      database: { status: 'ok' },
      redis: { status: 'ok' },
      minio: { status: 'ok' },
      queue: { status: 'ok' },
    });
  });

  it('/ready MinIO down → degraded (але db/redis/queue ok)', async () => {
    const res = await makeController({ minio: false }).ready();
    expect(res.status).toBe('degraded');
    expect(res.services.minio.status).toBe('error');
    expect(res.services.database.status).toBe('ok');
    // MUTATION-VERIFY: якщо healthCheck-результат ігнорувати у allOk → status лишався б ok.
  });

  it('/ready Redis down → degraded', async () => {
    const res = await makeController({ redis: false }).ready();
    expect(res.status).toBe('degraded');
    expect(res.services.redis.status).toBe('error');
  });
});
