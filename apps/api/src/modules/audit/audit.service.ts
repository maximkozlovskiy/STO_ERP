import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    orgId: string,
    entityType: string,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    userId: string,
    oldData?: Record<string, unknown>,
    newData?: Record<string, unknown>,
  ): Promise<void> {
    const diff = this.buildDiff(oldData, newData);
    await this.prisma.auditEvent.create({
      data: { orgId, entityType, entityId, action, userId, diff: diff as Prisma.InputJsonValue },
    });
  }

  private buildDiff(
    old?: Record<string, unknown>,
    next?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!old && next) return { new: next };
    if (old && !next) return { deleted: Object.keys(old) };
    if (!old || !next) return {};
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
    for (const key of keys) {
      if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) {
        changed[key] = { from: old[key], to: next[key] };
      }
    }
    return changed;
  }

  async findByEntity(
    orgId: string,
    entityType: string,
    entityId: string,
  ): Promise<{ items: AuditEventItem[]; total: number }> {
    const items = await this.prisma.auditEvent.findMany({
      where: { orgId, entityType, entityId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { firstName: true, lastName: true } },
      },
    });
    return {
      items: items.map((ev) => ({
        id: ev.id,
        action: ev.action,
        diff: ev.diff as Record<string, unknown>,
        createdAt: ev.createdAt.toISOString(),
        user: { firstName: ev.user.firstName, lastName: ev.user.lastName },
      })),
      total: items.length,
    };
  }
}

export interface AuditEventItem {
  id: string;
  action: string;
  diff: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string };
}
