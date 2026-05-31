import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CashRegisterResponseDto,
  CreateCashRegisterDto,
  UpdateCashRegisterDto,
} from './cash-registers.dto';

const TTL = 300;
const cacheKey = (orgId: string, branchId?: string) =>
  branchId ? `ref:cash-registers:${orgId}:${branchId}` : `ref:cash-registers:${orgId}`;

@Injectable()
export class CashRegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    branchId?: string,
  ): Promise<{ items: CashRegisterResponseDto[]; total: number }> {
    const key = cacheKey(orgId, branchId);
    const cached = await this.cache.get<{ items: CashRegisterResponseDto[]; total: number }>(key);
    if (cached) return cached;

    const where: Record<string, unknown> = { orgId, deletedAt: null };
    if (branchId) where['branchId'] = branchId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.cashRegister.findMany({
        where,
        include: {
          currency: { select: { code: true, symbol: true } },
          branch: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.cashRegister.count({ where }),
    ]);
    const result = { items: items.map(i => this.toDto(i)), total };
    await this.cache.set(key, result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<CashRegisterResponseDto> {
    const item = await this.prisma.cashRegister.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        currency: { select: { code: true, symbol: true } },
        branch: { select: { name: true } },
      },
    });
    if (!item) throw new NotFoundException('Касу не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateCashRegisterDto): Promise<CashRegisterResponseDto> {
    const [currency, branch] = await Promise.all([
      this.prisma.currency.findFirst({ where: { id: dto.currencyId, orgId, deletedAt: null } }),
      this.prisma.garageBranch.findFirst({ where: { id: dto.branchId, orgId, deletedAt: null } }),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const item = await this.prisma.cashRegister.create({
      data: { orgId, name: dto.name, currencyId: dto.currencyId, branchId: dto.branchId },
      include: {
        currency: { select: { code: true, symbol: true } },
        branch: { select: { name: true } },
      },
    });
    await this.cache.del(cacheKey(orgId));
    await this.cache.del(cacheKey(orgId, dto.branchId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateCashRegisterDto,
  ): Promise<CashRegisterResponseDto> {
    const existing = await this.prisma.cashRegister.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Касу не знайдено');

    const [currency, branch] = await Promise.all([
      dto.currencyId
        ? this.prisma.currency.findFirst({ where: { id: dto.currencyId, orgId, deletedAt: null } })
        : Promise.resolve(true as const),
      dto.branchId
        ? this.prisma.garageBranch.findFirst({
            where: { id: dto.branchId, orgId, deletedAt: null },
          })
        : Promise.resolve(true as const),
    ]);
    if (dto.currencyId && !currency) throw new NotFoundException('Валюту не знайдено');
    if (dto.branchId && !branch) throw new NotFoundException('Філію не знайдено');

    // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
    const updated = await this.prisma.cashRegister.updateMany({
      where: { id, orgId, deletedAt: null },
      data: dto,
    });
    if (updated.count === 0) throw new NotFoundException('Касу не знайдено');
    const item = await this.prisma.cashRegister.findFirstOrThrow({
      where: { id, orgId },
      include: {
        currency: { select: { code: true, symbol: true } },
        branch: { select: { name: true } },
      },
    });
    await this.cache.del(cacheKey(orgId));
    await this.cache.del(cacheKey(orgId, existing.branchId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: atomic soft-delete via updateMany (sto-review pattern 2026-05-30).
    // We still need the branchId for cache invalidation, so capture it first via findFirst —
    // but the actual mutation is the atomic guarded path.
    const existing = await this.prisma.cashRegister.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { branchId: true },
    });
    if (!existing) throw new NotFoundException('Касу не знайдено');
    const result = await this.prisma.cashRegister.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Касу не знайдено');
    await this.cache.del(cacheKey(orgId));
    await this.cache.del(cacheKey(orgId, existing.branchId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    currencyId: string;
    branchId: string;
    createdAt: Date;
    updatedAt: Date;
    currency: { code: string; symbol: string | null };
    branch: { name: string };
  }): CashRegisterResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      currencyId: item.currencyId,
      currencyCode: item.currency.code,
      currencySymbol: item.currency.symbol,
      branchId: item.branchId,
      branchName: item.branch.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
