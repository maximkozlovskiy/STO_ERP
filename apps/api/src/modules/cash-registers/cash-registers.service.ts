import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CashRegisterResponseDto, CreateCashRegisterDto, UpdateCashRegisterDto } from './cash-registers.dto';

@Injectable()
export class CashRegistersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    branchId?: string,
  ): Promise<{ items: CashRegisterResponseDto[]; total: number }> {
    const where: Record<string, unknown> = { orgId, deletedAt: null };
    if (branchId) where['branchId'] = branchId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.cashRegister.findMany({
        where,
        include: { currency: { select: { code: true, symbol: true } }, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.cashRegister.count({ where }),
    ]);
    return { items: items.map(i => this.toDto(i)), total };
  }

  async findOne(orgId: string, id: string): Promise<CashRegisterResponseDto> {
    const item = await this.prisma.cashRegister.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { currency: { select: { code: true, symbol: true } }, branch: { select: { name: true } } },
    });
    if (!item) throw new NotFoundException('Касу не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateCashRegisterDto): Promise<CashRegisterResponseDto> {
    const currency = await this.prisma.currency.findFirst({
      where: { id: dto.currencyId, orgId, deletedAt: null },
    });
    if (!currency) throw new NotFoundException('Валюту не знайдено');

    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const item = await this.prisma.cashRegister.create({
      data: { orgId, name: dto.name, currencyId: dto.currencyId, branchId: dto.branchId },
      include: { currency: { select: { code: true, symbol: true } }, branch: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateCashRegisterDto): Promise<CashRegisterResponseDto> {
    const existing = await this.prisma.cashRegister.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Касу не знайдено');

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

    const item = await this.prisma.cashRegister.update({
      where: { id },
      data: dto,
      include: { currency: { select: { code: true, symbol: true } }, branch: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.cashRegister.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Касу не знайдено');
    await this.prisma.cashRegister.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; currencyId: string; branchId: string;
    createdAt: Date; updatedAt: Date;
    currency: { code: string; symbol: string | null };
    branch: { name: string };
  }): CashRegisterResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name,
      currencyId: item.currencyId, currencyCode: item.currency.code,
      currencySymbol: item.currency.symbol,
      branchId: item.branchId, branchName: item.branch.name,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
