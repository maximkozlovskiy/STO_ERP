import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateServiceDto, UpdateServiceDto, ServiceResponseDto, PaginatedServicesDto } from './services.dto';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, page = 1, limit = 50, q?: string): Promise<PaginatedServicesDto> {
    const where: Prisma.ServiceWhereInput = { orgId, deletedAt: null };
    if (q) where.name = { contains: q, mode: 'insensitive' };

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where, orderBy: { name: 'asc' }, skip, take: limit,
        include: {
          serviceWorks: { include: { work: { select: { name: true, normoHours: true, price: true } } }, take: 1000 },
          serviceGoods: { include: { good: { select: { name: true, unit: true, salePrice: true } } }, take: 1000 },
        },
      }),
      this.prisma.service.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page, limit };
  }

  async findOne(orgId: string, id: string): Promise<ServiceResponseDto> {
    const item = await this.prisma.service.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        serviceWorks: { include: { work: { select: { name: true, normoHours: true, price: true } } }, take: 1000 },
        serviceGoods: { include: { good: { select: { name: true, unit: true, salePrice: true } } }, take: 1000 },
      },
    });
    if (!item) throw new NotFoundException('Послугу не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateServiceDto): Promise<ServiceResponseDto> {
    const item = await this.prisma.$transaction(async (tx) => {
      const svc = await tx.service.create({
        data: {
          orgId,
          name: dto.name,
          description: dto.description,
          price: dto.price ?? null,
        },
      });

      // Validate works + goods in parallel — independent queries on different tables.
      // Both are read-only within the transaction, so concurrent execution is safe.
      const [foundWorks, foundGoods] = await Promise.all([
        dto.works?.length
          ? tx.work.findMany({ where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null }, take: 1000 })
          : Promise.resolve([] as Array<{ id: string }>),
        dto.goods?.length
          ? tx.good.findMany({ where: { id: { in: dto.goods.map(g => g.goodId) }, orgId, deletedAt: null }, take: 1000 })
          : Promise.resolve([] as Array<{ id: string }>),
      ]);
      if (dto.works?.length) {
        if (foundWorks.length !== dto.works.length) throw new NotFoundException('Одну або кілька робіт не знайдено');
        await tx.serviceWork.createMany({
          data: dto.works.map((w) => ({ serviceId: svc.id, workId: w.workId, quantity: w.quantity ?? 1 })),
        });
      }
      if (dto.goods?.length) {
        if (foundGoods.length !== dto.goods.length) throw new NotFoundException('Один або кілька товарів не знайдено');
        await tx.serviceGood.createMany({
          data: dto.goods.map((g) => ({ serviceId: svc.id, goodId: g.goodId, quantity: g.quantity ?? 1 })),
        });
      }

      return tx.service.findFirstOrThrow({
        where: { id: svc.id, orgId, deletedAt: null },
        include: {
          serviceWorks: { include: { work: { select: { name: true, normoHours: true, price: true } } }, take: 1000 },
          serviceGoods: { include: { good: { select: { name: true, unit: true, salePrice: true } } }, take: 1000 },
        },
      });
    }, { timeout: 5_000 }); // Bug #132: explicit timeout

    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateServiceDto): Promise<ServiceResponseDto> {
    await this.findOne(orgId, id);

    const item = await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id, orgId },
        data: {
          name: dto.name,
          description: dto.description,
          price: dto.price !== undefined ? (dto.price ?? null) : undefined,
        },
      });

      // Parallel cross-tenant FK validation for works + goods (independent reads).
      const [foundWorks, foundGoods] = await Promise.all([
        dto.works?.length
          ? tx.work.findMany({ where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null }, take: 1000 })
          : Promise.resolve([] as Array<{ id: string }>),
        dto.goods?.length
          ? tx.good.findMany({ where: { id: { in: dto.goods.map(g => g.goodId) }, orgId, deletedAt: null }, take: 1000 })
          : Promise.resolve([] as Array<{ id: string }>),
      ]);
      if (dto.works !== undefined) {
        if (dto.works.length && foundWorks.length !== dto.works.length) {
          throw new NotFoundException('Одну або кілька робіт не знайдено');
        }
        await tx.serviceWork.deleteMany({ where: { serviceId: id } });
        if (dto.works.length) {
          await tx.serviceWork.createMany({
            data: dto.works.map((w) => ({ serviceId: id, workId: w.workId, quantity: w.quantity ?? 1 })),
          });
        }
      }
      if (dto.goods !== undefined) {
        if (dto.goods.length && foundGoods.length !== dto.goods.length) {
          throw new NotFoundException('Один або кілька товарів не знайдено');
        }
        await tx.serviceGood.deleteMany({ where: { serviceId: id } });
        if (dto.goods.length) {
          await tx.serviceGood.createMany({
            data: dto.goods.map((g) => ({ serviceId: id, goodId: g.goodId, quantity: g.quantity ?? 1 })),
          });
        }
      }

      return tx.service.findFirstOrThrow({
        where: { id, orgId, deletedAt: null },
        include: {
          serviceWorks: { include: { work: { select: { name: true, normoHours: true, price: true } } }, take: 1000 },
          serviceGoods: { include: { good: { select: { name: true, unit: true, salePrice: true } } }, take: 1000 },
        },
      });
    }, { timeout: 5_000 }); // Bug #132: explicit timeout

    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.service.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; description: string | null; price: import('@prisma/client').Prisma.Decimal | null;
    createdAt: Date; updatedAt: Date;
    serviceWorks: Array<{ workId: string; quantity: number; work: { name: string; normoHours: number; price: import('@prisma/client').Prisma.Decimal } }>;
    serviceGoods: Array<{ goodId: string; quantity: number; good: { name: string; unit: string; salePrice: import('@prisma/client').Prisma.Decimal } }>;
  }): ServiceResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      description: item.description ?? null,
      price: item.price != null ? Number(item.price) : null,
      works: item.serviceWorks.map((sw) => ({
        workId: sw.workId,
        workName: sw.work.name,
        normoHours: sw.work.normoHours,
        price: Number(sw.work.price),
        quantity: sw.quantity,
      })),
      goods: item.serviceGoods.map((sg) => ({
        goodId: sg.goodId,
        goodName: sg.good.name,
        unit: sg.good.unit,
        salePrice: Number(sg.good.salePrice),
        quantity: sg.quantity,
      })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
