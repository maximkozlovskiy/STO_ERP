import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { CashService } from '../cash/cash.service';
import {
  CashRegisterResponseDto,
  CreateCashRegisterDto,
  UpdateCashRegisterDto,
} from './cash-registers.dto';

// Кеш НЕ включає balance (він змінюється кожною операцією) — кешується лише статична частина каси;
// balance рахується свіжим після читання (getBalance по cash_operations).
const TTL = 300;
const cacheKey = (orgId: string, branchId?: string) =>
  branchId ? `ref:cash-registers:${orgId}:${branchId}` : `ref:cash-registers:${orgId}`;

@Injectable()
export class CashRegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly cash: CashService,
  ) {}

  async findAll(
    orgId: string,
    branchId?: string,
  ): Promise<{ items: CashRegisterResponseDto[]; total: number }> {
    const key = cacheKey(orgId, branchId);
    let payload = await this.cache.get<{ items: CashRegisterResponseDto[]; total: number }>(key);
    if (!payload) {
      const where: Record<string, unknown> = { orgId, deletedAt: null };
      if (branchId) where['branchId'] = branchId;
      const [items, total] = await Promise.all([
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
      payload = { items: items.map(i => this.toDto(i)), total };
      await this.cache.set(key, payload, TTL);
    }
    // Balance завжди свіжий (поза кешем).
    const withBalance = await Promise.all(
      payload.items.map(async i => ({
        ...i,
        balance: await this.cash.getBalance(orgId, i.id),
      })),
    );
    return { items: withBalance, total: payload.total };
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
    const dto = this.toDto(item);
    dto.balance = await this.cash.getBalance(orgId, id);
    return dto;
  }

  async create(orgId: string, dto: CreateCashRegisterDto): Promise<CashRegisterResponseDto> {
    // sto-optimize: narrow FK guards — only existence is checked, full rows are not used.
    const [currency, branch] = await Promise.all([
      this.prisma.currency.findFirst({
        where: { id: dto.currencyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const isFiscal = dto.isFiscal ?? false;
    await this.assertFiscalProvider(orgId, dto.branchId, isFiscal, dto.fiscalProvider);

    const item = await this.prisma.cashRegister.create({
      data: {
        orgId,
        name: dto.name,
        currencyId: dto.currencyId,
        branchId: dto.branchId,
        isFiscal,
        fiscalProvider: dto.fiscalProvider ?? null,
        providerCashRegisterId: dto.providerCashRegisterId ?? null,
        initialBalance: dto.initialBalance ?? 0,
      },
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
    // Tier merger: existing tenant guard + optional FK validation у єдиний Promise.all
    // (sto-optimize pattern 2026-05-31). existing.branchId потрібен для cache invalidation,
    // тому select narrow projection. 3 RTT → 1 RTT.
    const [existing, currency, branch] = await Promise.all([
      this.prisma.cashRegister.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { branchId: true, isFiscal: true, fiscalProvider: true },
      }),
      dto.currencyId
        ? this.prisma.currency.findFirst({
            where: { id: dto.currencyId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(true as const),
      dto.branchId
        ? this.prisma.garageBranch.findFirst({
            where: { id: dto.branchId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(true as const),
    ]);
    if (!existing) throw new NotFoundException('Касу не знайдено');
    if (dto.currencyId && !currency) throw new NotFoundException('Валюту не знайдено');
    if (dto.branchId && !branch) throw new NotFoundException('Філію не знайдено');

    // Ефективні значення після мерджу (dto перекриває наявне) — валідуємо привʼязку до ПРРО.
    const effectiveBranchId = dto.branchId ?? existing.branchId;
    const effectiveIsFiscal = dto.isFiscal ?? existing.isFiscal;
    const effectiveProvider =
      dto.fiscalProvider !== undefined ? dto.fiscalProvider : existing.fiscalProvider;
    await this.assertFiscalProvider(
      orgId,
      effectiveBranchId,
      effectiveIsFiscal,
      effectiveProvider ?? undefined,
    );

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
    // Якщо змінили філію — інвалідовуємо і кеш НОВОЇ філії (інакше стара per-branch вибірка
    // показуватиме касу до TTL, а нова — не покаже до TTL).
    if (dto.branchId && dto.branchId !== existing.branchId)
      await this.cache.del(cacheKey(orgId, dto.branchId));
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

  /**
   * Валідує привʼязку каси до ПРРО-провайдера:
   *  - fiscalProvider можна задати лише фіскальній касі (isFiscal=true);
   *  - провайдер має бути серед налаштованих BranchProviderConfig(kind=FISCAL) тієї ж філії
   *    (креди введено — hasCredentials). Інакше касу неможливо фіскалізувати.
   */
  private async assertFiscalProvider(
    orgId: string,
    branchId: string,
    isFiscal: boolean,
    fiscalProvider: string | undefined,
  ): Promise<void> {
    if (!fiscalProvider) return; // не привʼязано — ок (fallback на per-branch провайдера)
    if (!isFiscal) {
      throw new BadRequestException(
        'Провайдера ПРРО можна привʼязати лише до фіскальної каси (увімкніть «Фіскальна каса»)',
      );
    }
    const cfg = await this.prisma.branchProviderConfig.findFirst({
      where: { orgId, branchId, kind: 'FISCAL', provider: fiscalProvider, deletedAt: null },
      select: { credentials: true },
    });
    if (!cfg || !cfg.credentials) {
      throw new BadRequestException(
        'Провайдера ПРРО не налаштовано для цієї філії — спершу введіть його креди у Налаштуваннях',
      );
    }
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    currencyId: string;
    branchId: string;
    isFiscal: boolean;
    fiscalProvider: string | null;
    providerCashRegisterId: string | null;
    initialBalance: unknown; // Prisma.Decimal
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
      isFiscal: item.isFiscal,
      fiscalProvider: item.fiscalProvider,
      providerCashRegisterId: item.providerCashRegisterId,
      initialBalance: Number(item.initialBalance),
      balance: Number(item.initialBalance), // перекривається свіжим getBalance у findAll/findOne
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
