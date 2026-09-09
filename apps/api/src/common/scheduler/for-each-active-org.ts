import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Cursor-пагінований обхід усіх активних (не soft-deleted) організацій батчами.
 *
 * Замінює патерн `organisation.findMany({ take: 1000 })` + warning про ліміт, що
 * дублювався у FollowUp/Overdue/NBU scheduler-ах (Bug #107 — cloud multi-tenant
 * >1000 орг тихо не охоплювались). Keyset-пагінація по `id` (стабільний cursor,
 * без OFFSET-дрейфу): кожен батч дає per-org callback, який реєструє repeatable-job.
 *
 * ADR-001: on-prem = 1 org → один короткий батч. Для cloud (N орг) — повне покриття
 * без ліміту й без завантаження всіх id у пам'ять одночасно.
 *
 * @returns загальна к-сть охоплених організацій (для startup-логу).
 */
export async function forEachActiveOrg(
  prisma: PrismaService,
  handleBatch: (orgIds: string[]) => Promise<void>,
  opts: { batchSize?: number; logger?: Logger } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 500;
  let cursor: string | undefined;
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await prisma.organisation.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;

    await handleBatch(batch.map(o => o.id));
    total += batch.length;
    cursor = batch[batch.length - 1].id;

    // Останній (неповний) батч → більше сторінок немає.
    if (batch.length < batchSize) break;
  }

  return total;
}
