import { Injectable, NotFoundException } from '@nestjs/common';
import type { EmployeeNotification, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { calculatePagination } from '../../common/utils/pagination';
import type {
  EmployeeNotificationListQueryDto,
  EmployeeNotificationResponseDto,
  PaginatedEmployeeNotificationsDto,
} from './automation.dto';

const toDto = (n: EmployeeNotification): EmployeeNotificationResponseDto => ({
  id: n.id,
  title: n.title,
  body: n.body,
  documentType: n.documentType,
  documentId: n.documentId,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

/**
 * Сповіщення працівника в системі — дзвіночок (BR-AUT-021). Кожен бачить і позначає лише свої:
 * `employeeId` з токена стоїть у `where` КОЖНОГО читання й запису (BR-AUT-052).
 */
@Injectable()
export class EmployeeNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(
    orgId: string,
    employeeId: string,
    query: EmployeeNotificationListQueryDto,
  ): Promise<PaginatedEmployeeNotificationsDto> {
    const { skip, take } = calculatePagination({
      page: query.page,
      limit: query.limit,
      maxLimit: 100,
    });
    const unread = query.unread === 'true' || query.unread === '1';
    const where: Prisma.EmployeeNotificationWhereInput = {
      orgId,
      employeeId,
      deletedAt: null,
      ...(unread && { readAt: null }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.employeeNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.employeeNotification.count({ where }),
    ]);
    return { items: rows.map(toDto), total, page: query.page, limit: take };
  }

  async unreadCount(orgId: string, employeeId: string): Promise<{ count: number }> {
    const count = await this.prisma.employeeNotification.count({
      where: { orgId, employeeId, deletedAt: null, readAt: null },
    });
    return { count };
  }

  /** Повторне «прочитано» — без змін (дата першого прочитання лишається). Чуже — 404. */
  async markRead(
    orgId: string,
    employeeId: string,
    id: string,
  ): Promise<EmployeeNotificationResponseDto> {
    await this.prisma.employeeNotification.updateMany({
      where: { id, orgId, employeeId, deletedAt: null, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.employeeNotification.findFirst({
      where: { id, orgId, employeeId, deletedAt: null },
    });
    if (!row) throw new NotFoundException(err('err.automation.notificationNotFound'));
    return toDto(row);
  }

  async markAllRead(orgId: string, employeeId: string): Promise<{ updated: number }> {
    const res = await this.prisma.employeeNotification.updateMany({
      where: { orgId, employeeId, deletedAt: null, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }
}
