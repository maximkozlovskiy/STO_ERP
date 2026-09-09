import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCommentDto,
  CommentResponseDto,
  CommentsListResponseDto,
  COMMENT_ENTITY_TYPES,
  type CommentEntityType,
} from './comments.dto';

function isAllowedEntityType(value: string): value is CommentEntityType {
  return (COMMENT_ENTITY_TYPES as readonly string[]).includes(value);
}

type CommentWithAuthor = {
  id: string;
  orgId: string;
  entityType: string;
  entityId: string;
  body: string;
  authorId: string;
  createdAt: Date;
  author: { firstName: string; lastName: string };
};

@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    entityType: string,
    entityId: string,
  ): Promise<CommentsListResponseDto> {
    // Reject arbitrary entity types — without this guard, callers could probe arbitrary
    // string values and bypass the polymorphic relation contract. Also keeps the composite
    // index `(orgId, entityType, entityId, createdAt)` selective.
    if (!isAllowedEntityType(entityType)) {
      throw new BadRequestException(`Невідомий тип сутності для коментарів: ${entityType}`);
    }
    if (!entityId || typeof entityId !== 'string') {
      throw new BadRequestException("entityId обов'язковий");
    }
    const [items, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { orgId, entityType, entityId },
        // sto-optimize: narrow select — toDto читає лише id/orgId/entityType/entityId/body/authorId/
        // createdAt/author. Раніше include тягнуло syncVersion/deletedAt + всі скалярні колонки.
        select: {
          id: true,
          orgId: true,
          entityType: true,
          entityId: true,
          body: true,
          authorId: true,
          createdAt: true,
          author: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
      this.prisma.comment.count({ where: { orgId, entityType, entityId } }),
    ]);

    return {
      items: items.map(c => this.toDto(c)),
      total,
    };
  }

  async create(
    orgId: string,
    authorId: string,
    dto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    // Cross-tenant FK guard: `Comment.entityId` is a polymorphic reference without a Prisma FK.
    // Without this check, a user from org A can create a comment about an entity from org B →
    // `Comment.orgId=A, entityId=<from-B>` sits in the DB invisible to both sides, breaking audit-trail.
    await this.assertEntityBelongsToOrg(orgId, dto.entityType, dto.entityId);
    const comment = await this.prisma.comment.create({
      data: { orgId, entityType: dto.entityType, entityId: dto.entityId, body: dto.body, authorId },
      include: { author: { select: { firstName: true, lastName: true } } },
    });
    return this.toDto(comment);
  }

  /**
   * Assert polymorphic entity belongs to org. Uses a map instead of switch —
   * easier to add new entity types (Vehicle, Invoice, ...).
   */
  private async assertEntityBelongsToOrg(
    orgId: string,
    entityType: CommentEntityType,
    entityId: string,
  ): Promise<void> {
    const where = { id: entityId, orgId, deletedAt: null } as const;
    const fetchers: Record<CommentEntityType, () => Promise<{ id: string } | null>> = {
      WorkOrder: () => this.prisma.workOrder.findFirst({ where, select: { id: true } }),
      Counterparty: () => this.prisma.counterparty.findFirst({ where, select: { id: true } }),
      Vehicle: () => this.prisma.vehicle.findFirst({ where, select: { id: true } }),
      Invoice: () => this.prisma.invoice.findFirst({ where, select: { id: true } }),
    };
    const parent = await fetchers[entityType]();
    if (!parent) throw new NotFoundException('Сутність не знайдено');
  }

  async remove(orgId: string, id: string, user: { id: string; role: string }): Promise<void> {
    // sto-optimize: narrow select — для permission check потрібен лише authorId.
    // Раніше тягнуло body/createdAt/syncVersion/deletedAt/entityType/entityId/orgId — все ігнорувалось.
    const comment = await this.prisma.comment.findFirst({
      where: { id, orgId },
      select: { authorId: true },
    });
    if (!comment) throw new NotFoundException('Коментар не знайдено');
    // Only the comment author or an owner/admin can delete. Without this check ANY authenticated
    // employee could erase another employee's notes — a moderation/audit problem.
    const isAuthor = comment.authorId === user.id;
    const isAdmin = user.role === 'OWNER' || user.role === 'ADMIN';
    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException('Видаляти коментарі можуть лише автор або адміністратор');
    }
    // Defense-in-depth: atomic deleteMany with orgId guard (sto-review pattern 2026-05-30).
    // Eliminates race-window between findFirst guard and hard delete that could otherwise
    // permit cross-tenant removal under concurrent sessions.
    const result = await this.prisma.comment.deleteMany({ where: { id, orgId } });
    if (result.count === 0) throw new NotFoundException('Коментар не знайдено');
  }

  private toDto(c: CommentWithAuthor): CommentResponseDto {
    return {
      id: c.id,
      orgId: c.orgId,
      entityType: c.entityType,
      entityId: c.entityId,
      body: c.body,
      authorId: c.authorId,
      authorName: `${c.author.firstName} ${c.author.lastName}`.trim(),
      createdAt: c.createdAt.toISOString(),
    };
  }
}
