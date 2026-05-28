import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BankAccountResponseDto, CreateBankAccountDto, UpdateBankAccountDto } from './bank-accounts.dto';

@Injectable()
export class BankAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<{ items: BankAccountResponseDto[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.bankAccount.findMany({
        where: { orgId, deletedAt: null },
        include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.bankAccount.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(i => this.toDto(i)), total };
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
    const currency = await this.prisma.currency.findFirst({
      where: { id: dto.currencyId, orgId, deletedAt: null },
    });
    if (!currency) throw new NotFoundException('Валюту не знайдено');

    if (dto.branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
      });
      if (!branch) throw new NotFoundException('Філію не знайдено');
    }

    const item = await this.prisma.bankAccount.create({
      data: { orgId, name: dto.name, ibanUA: dto.ibanUA, currencyId: dto.currencyId,
        bankName: dto.bankName, branchId: dto.branchId, mfo: dto.mfo,
        edrpou: dto.edrpou, bankAddress: dto.bankAddress },
      include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBankAccountDto): Promise<BankAccountResponseDto> {
    const existing = await this.prisma.bankAccount.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Банківський рахунок не знайдено');

    if (dto.currencyId) {
      const currency = await this.prisma.currency.findFirst({
        where: { id: dto.currencyId, orgId, deletedAt: null },
      });
      if (!currency) throw new NotFoundException('Валюту не знайдено');
    }

    if (dto.branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
      });
      if (!branch) throw new NotFoundException('Філію не знайдено');
    }

    const item = await this.prisma.bankAccount.update({
      where: { id },
      data: dto,
      include: { currency: { select: { code: true } }, branch: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.bankAccount.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Банківський рахунок не знайдено');
    await this.prisma.bankAccount.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; ibanUA: string; currencyId: string;
    bankName: string | null; branchId: string | null; mfo: string | null;
    edrpou: string | null; bankAddress: string | null; createdAt: Date; updatedAt: Date;
    currency: { code: string };
    branch: { name: string } | null;
  }): BankAccountResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name, ibanUA: item.ibanUA,
      currencyId: item.currencyId, currencyCode: item.currency.code,
      bankName: item.bankName, branchId: item.branchId,
      branchName: item.branch?.name ?? null,
      mfo: item.mfo, edrpou: item.edrpou, bankAddress: item.bankAddress,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
