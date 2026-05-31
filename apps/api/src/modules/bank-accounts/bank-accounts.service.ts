import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  BankAccountResponseDto,
  CreateBankAccountDto,
  UpdateBankAccountDto,
} from './bank-accounts.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:bank-accounts:${orgId}`;

@Injectable()
export class BankAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<{ items: BankAccountResponseDto[]; total: number }> {
    const cached = await this.cache.get<{ items: BankAccountResponseDto[]; total: number }>(
      cacheKey(orgId),
    );
    if (cached) return cached;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.bankAccount.findMany({
        where: { orgId, deletedAt: null },
        include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.bankAccount.count({ where: { orgId, deletedAt: null } }),
    ]);
    const result = { items: items.map(i => this.toDto(i)), total };
    await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<BankAccountResponseDto> {
    const item = await this.prisma.bankAccount.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
    });
    if (!item) throw new NotFoundException('Банківський рахунок не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateBankAccountDto): Promise<BankAccountResponseDto> {
    const [currency, branch] = await Promise.all([
      this.prisma.currency.findFirst({ where: { id: dto.currencyId, orgId, deletedAt: null } }),
      dto.branchId
        ? this.prisma.garageBranch.findFirst({
            where: { id: dto.branchId, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    if (dto.branchId && !branch) throw new NotFoundException('Філію не знайдено');

    const item = await this.prisma.bankAccount.create({
      data: {
        orgId,
        name: dto.name,
        ibanUA: dto.ibanUA,
        currencyId: dto.currencyId,
        bankName: dto.bankName,
        branchId: dto.branchId,
        mfo: dto.mfo,
        edrpou: dto.edrpou,
        bankAddress: dto.bankAddress,
      },
      include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    const existing = await this.prisma.bankAccount.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Банківський рахунок не знайдено');

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
    // updateMany does not accept `include`, so re-fetch with relations afterwards.
    const updated = await this.prisma.bankAccount.updateMany({
      where: { id, orgId, deletedAt: null },
      data: dto,
    });
    if (updated.count === 0) throw new NotFoundException('Банківський рахунок не знайдено');
    const item = await this.prisma.bankAccount.findFirstOrThrow({
      where: { id, orgId },
      include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: atomic soft-delete via updateMany with orgId guard
    // (sto-review pattern 2026-05-30). Eliminates the race-window between findFirst
    // and update that could otherwise allow cross-tenant soft-delete.
    const result = await this.prisma.bankAccount.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Банківський рахунок не знайдено');
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    ibanUA: string;
    currencyId: string;
    bankName: string | null;
    branchId: string | null;
    mfo: string | null;
    edrpou: string | null;
    bankAddress: string | null;
    createdAt: Date;
    updatedAt: Date;
    currency: { code: string };
    branch: { name: string } | null;
  }): BankAccountResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      ibanUA: item.ibanUA,
      currencyId: item.currencyId,
      currencyCode: item.currency.code,
      bankName: item.bankName,
      branchId: item.branchId,
      branchName: item.branch?.name ?? null,
      mfo: item.mfo,
      edrpou: item.edrpou,
      bankAddress: item.bankAddress,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
