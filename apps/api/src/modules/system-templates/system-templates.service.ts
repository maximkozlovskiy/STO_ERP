import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { SystemTemplateResponseDto } from './system-templates.dto';

const TTL = 3600; // шаблони змінюються тільки через deploy/seed
const cacheKey = (entityType: string) => `sys:templates:${entityType}`;
const ALL_KEY = 'sys:templates:all';

@Injectable()
export class SystemTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(entityType?: string): Promise<SystemTemplateResponseDto[]> {
    const key = entityType ? cacheKey(entityType) : ALL_KEY;
    const cached = await this.cache.get<SystemTemplateResponseDto[]>(key);
    if (cached) return cached;

    const items = await this.prisma.systemTemplate.findMany({
      where: entityType ? { entityType } : undefined,
      orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }],
      // Seed-managed catalogue (size bounded by deploy/seed), but enforce explicit
      // upper bound to satisfy §3.2 OOM guard — system templates fit comfortably under 500.
      take: 500,
    });

    const result = items.map(item => this.toDto(item));
    await this.cache.set(key, result, TTL);
    return result;
  }

  private toDto(item: {
    id: string;
    entityType: string;
    key: string;
    name: string;
    data: unknown;
    sortOrder: number;
  }): SystemTemplateResponseDto {
    return {
      id: item.id,
      entityType: item.entityType,
      key: item.key,
      name: item.name,
      data: item.data as Record<string, unknown>,
      sortOrder: item.sortOrder,
    };
  }
}
