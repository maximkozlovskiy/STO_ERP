import { Injectable, NotFoundException } from '@nestjs/common';
import { CounterpartyType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CounterpartyQueryDto, CounterpartyResponseDto, CreateCounterpartyDto,
  CreateGarageDto, GarageResponseDto, PaginatedCounterpartiesDto, UpdateCounterpartyDto,
} from './counterparties.dto';

@Injectable()
export class CounterpartiesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, query: CounterpartyQueryDto): Promise<PaginatedCounterpartiesDto> {
    const where = {
      orgId, deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.q ? {
        OR: [
          { firstName: { contains: query.q, mode: 'insensitive' as const } },
          { lastName: { contains: query.q, mode: 'insensitive' as const } },
          { companyName: { contains: query.q, mode: 'insensitive' as const } },
          { phone: { contains: query.q } },
          { edrpou: { contains: query.q } },
        ],
      } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.counterparty.findMany({
        where,
        include: { settlementAccount: { select: { balance: true } } },
        orderBy: [{ lastName: 'asc' }, { companyName: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.counterparty.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total, page: query.page, limit: query.limit,
    };
  }

  async findOne(orgId: string, id: string): Promise<CounterpartyResponseDto> {
    const item = await this.prisma.counterparty.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { settlementAccount: { select: { balance: true } } },
    });
    if (!item) throw new NotFoundException('Контрагента не знайдено');
    return this.toDto(item, true);
  }

  async create(orgId: string, dto: CreateCounterpartyDto): Promise<CounterpartyResponseDto> {
    const item = await this.prisma.$transaction(async (tx) => {
      const cp = await tx.counterparty.create({ data: { ...dto, orgId } });
      // Auto-create settlement account
      await tx.settlementAccount.create({
        data: { orgId, counterpartyId: cp.id, balance: 0 },
      });
      return tx.counterparty.findFirstOrThrow({
        where: { id: cp.id, orgId, deletedAt: null },
        include: { settlementAccount: { select: { balance: true } } },
      });
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateCounterpartyDto): Promise<CounterpartyResponseDto> {
    const existing = await this.prisma.counterparty.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Контрагента не знайдено');
    const item = await this.prisma.counterparty.update({
      where: { id, orgId },
      data: dto,
      include: { settlementAccount: { select: { balance: true } } },
    });
    return this.toDto(item, true);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.counterparty.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Контрагента не знайдено');
    await this.prisma.counterparty.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  // ─── Garages ─────────────────────────────────────────────

  async findGarages(orgId: string, counterpartyId: string): Promise<GarageResponseDto[]> {
    await this.findOne(orgId, counterpartyId);
    const items = await this.prisma.customerGarage.findMany({
      where: { counterpartyId, orgId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return items.map(item => this.toGarageDto(item));
  }

  async createGarage(orgId: string, counterpartyId: string, dto: CreateGarageDto): Promise<GarageResponseDto> {
    await this.findOne(orgId, counterpartyId);
    const item = await this.prisma.customerGarage.create({
      data: { orgId, counterpartyId, ...dto },
    });
    return this.toGarageDto(item);
  }

  async removeGarage(orgId: string, counterpartyId: string, garageId: string): Promise<void> {
    await this.findOne(orgId, counterpartyId);
    const garage = await this.prisma.customerGarage.findFirst({
      where: { id: garageId, counterpartyId, orgId, deletedAt: null },
    });
    if (!garage) throw new NotFoundException('Гараж не знайдено');
    await this.prisma.customerGarage.update({ where: { id: garageId, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; type: string; firstName: string | null; lastName: string | null;
    companyName: string | null; edrpou: string | null; vatPayer: boolean; phone: string | null;
    email: string | null; notes: string | null; createdAt: Date; updatedAt: Date;
    settlementAccount: { balance: Prisma.Decimal } | null;
  }, includeEdrpou = false): CounterpartyResponseDto {
    return {
      id: item.id, orgId: item.orgId, type: item.type as CounterpartyType,
      firstName: item.firstName, lastName: item.lastName,
      companyName: item.companyName,
      // edrpou exposed only on detail view — sensitive identifier
      edrpou: includeEdrpou ? item.edrpou : undefined,
      vatPayer: item.vatPayer, phone: item.phone, email: item.email, notes: item.notes,
      balance: item.settlementAccount ? Number(item.settlementAccount.balance) : 0,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }

  private toGarageDto(g: { id: string; counterpartyId: string; name: string; address: string | null; notes: string | null; createdAt: Date }): GarageResponseDto {
    return { id: g.id, counterpartyId: g.counterpartyId, name: g.name, address: g.address, notes: g.notes, createdAt: g.createdAt };
  }
}
