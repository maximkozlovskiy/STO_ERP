import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCommentDto, CommentResponseDto, CommentsListResponseDto } from './comments.dto';

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
    const [items, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { orgId, entityType, entityId },
        include: { author: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
      this.prisma.comment.count({ where: { orgId, entityType, entityId } }),
    ]);

    return {
      items: items.map((c) => this.toDto(c as CommentWithAuthor)),
      total,
    };
  }

  async create(
    orgId: string,
    authorId: string,
    dto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    const comment = await this.prisma.comment.create({
      data: { orgId, entityType: dto.entityType, entityId: dto.entityId, body: dto.body, authorId },
      include: { author: { select: { firstName: true, lastName: true } } },
    });
    return this.toDto(comment as CommentWithAuthor);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const comment = await this.prisma.comment.findFirst({ where: { id, orgId } });
    if (!comment) throw new NotFoundException('Коментар не знайдено');
    await this.prisma.comment.delete({ where: { id } });
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
