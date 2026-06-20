import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateServiceDto,
  UpdateServiceDto,
  ServiceResponseDto,
  PaginatedServicesDto,
} from './services.dto';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(orgId: string, id: string): Promise<ServiceResponseDto> {
    const item = await this.prisma.service.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        serviceWorks: {
          include: { work: { select: { name: true, normoHours: true, price: true } } },
          take: 1000,
        },
        serviceGoods: {
          include: { good: { select: { name: true, unit: true, salePrice: true } } },
          take: 1000,
        },
      },
    });
    if (!item) throw new NotFoundException('Послугу не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateServiceDto): Promise<ServiceResponseDto> {
    const item = await this.prisma.$transaction(
      async tx => {
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
        // sto-optimize: count() instead of findMany() — Postgres returns a single
        // integer instead of N IDs that downstream code never reads.
        const [foundWorksCount, foundGoodsCount] = await Promise.all([
          dto.works?.length
            ? tx.work.count({
                where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null },
              })
            : Promise.resolve(0),
          dto.goods?.length
            ? tx.good.count({
                where: { id: { in: dto.goods.map(g => g.goodId) }, orgId, deletedAt: null },
              })
            : Promise.resolve(0),
        ]);
        if (dto.works?.length) {
          if (foundWorksCount !== dto.works.length)
            throw new NotFoundException('Одну або кілька робіт не знайдено');
          await tx.serviceWork.createMany({
            data: dto.works.map(w => ({
              serviceId: svc.id,
              workId: w.workId,
              quantity: w.quantity ?? 1,
            })),
          });
        }
        if (dto.goods?.length) {
          if (foundGoodsCount !== dto.goods.length)
            throw new NotFoundException('Один або кілька товарів не знайдено');
          await tx.serviceGood.createMany({
            data: dto.goods.map(g => ({
              serviceId: svc.id,
              goodId: g.goodId,
              quantity: g.quantity ?? 1,
            })),
          });
        }

        return tx.service.findFirstOrThrow({
          where: { id: svc.id, orgId, deletedAt: null },
          include: {
            serviceWorks: {
              include: { work: { select: { name: true, normoHours: true, price: true } } },
              take: 1000,
            },
            serviceGoods: {
              include: { good: { select: { name: true, unit: true, salePrice: true } } },
              take: 1000,
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateServiceDto): Promise<ServiceResponseDto> {
    // sto-optimize: replace findOne (full DTO + serviceWorks/serviceGoods includes)
    // with narrow existence check. Update path below повертає full DTO у tx.
    const existing = await this.prisma.service.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Послугу не знайдено');

    const item = await this.prisma.$transaction(
      async tx => {
        await tx.service.update({
          where: { id, orgId },
          data: {
            name: dto.name,
            description: dto.description,
            price: dto.price !== undefined ? (dto.price ?? null) : undefined,
          },
        });

        // Parallel cross-tenant FK validation for works + goods (independent reads).
        // sto-optimize: count() instead of findMany() — only the length comparison
        // is used downstream; Postgres returns a single integer instead of N row IDs.
        const [foundWorksCount, foundGoodsCount] = await Promise.all([
          dto.works?.length
            ? tx.work.count({
                where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null },
              })
            : Promise.resolve(0),
          dto.goods?.length
            ? tx.good.count({
                where: { id: { in: dto.goods.map(g => g.goodId) }, orgId, deletedAt: null },
              })
            : Promise.resolve(0),
        ]);
        if (dto.works !== undefined) {
          if (dto.works.length && foundWorksCount !== dto.works.length) {
            throw new NotFoundException('Одну або кілька робіт не знайдено');
          }
          await tx.serviceWork.deleteMany({ where: { serviceId: id } });
          if (dto.works.length) {
            await tx.serviceWork.createMany({
              data: dto.works.map(w => ({
                serviceId: id,
                workId: w.workId,
                quantity: w.quantity ?? 1,
              })),
            });
          }
        }
        if (dto.goods !== undefined) {
          if (dto.goods.length && foundGoodsCount !== dto.goods.length) {
            throw new NotFoundException('Один або кілька товарів не знайдено');
          }
          await tx.serviceGood.deleteMany({ where: { serviceId: id } });
          if (dto.goods.length) {
            await tx.serviceGood.createMany({
              data: dto.goods.map(g => ({
                serviceId: id,
                goodId: g.goodId,
                quantity: g.quantity ?? 1,
              })),
            });
          }
        }

        return tx.service.findFirstOrThrow({
          where: { id, orgId, deletedAt: null },
          include: {
            serviceWorks: {
              include: { work: { select: { name: true, normoHours: true, price: true } } },
              take: 1000,
            },
            serviceGoods: {
              include: { good: { select: { name: true, unit: true, salePrice: true } } },
              take: 1000,
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null). -1 RTT per delete; findOne loaded full Service
    // with works/goods includes лише для 404 guard, що марно.
    const result = await this.prisma.service.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Послугу не знайдено');
  }

  async restore(orgId: string, id: string): Promise<ServiceResponseDto> {
    // Defense-in-depth: atomic updateMany with full compound where (sto-review pattern 2026-05-30).
    // updateMany returns count → translate 0 → 404, eliminating the race window between
    // a separate findFirst + update() that could resurrect a record concurrently soft-deleted
    // (or worse, write to a record from another org if the FK pre-check passed but ownership
    // changed). orgId + NOT deletedAt: null guarantees both tenant isolation and "must be
    // currently deleted" invariant in a single statement.
    const result = await this.prisma.service.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалену послугу не знайдено');

    const item = await this.prisma.service.findFirstOrThrow({
      where: { id, orgId },
      include: {
        serviceWorks: {
          include: { work: { select: { name: true, normoHours: true, price: true } } },
          take: 1000,
        },
        serviceGoods: {
          include: { good: { select: { name: true, unit: true, salePrice: true } } },
          take: 1000,
        },
      },
    });
    return this.toDto(item);
  }

  async findAll(
    orgId: string,
    page = 1,
    limit = 50,
    q?: string,
    showDeleted = false,
  ): Promise<PaginatedServicesDto> {
    const where: Prisma.ServiceWhereInput = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    if (q) where.name = { contains: q, mode: 'insensitive' };

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.service.findMany({
        where,
        // Postgres puts NULLs last in ASC — explicit `nulls: 'first'` shows active records
        // before deleted ones in showDeleted=true lists.
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        skip,
        take: limit,
        include: {
          serviceWorks: {
            include: { work: { select: { name: true, normoHours: true, price: true } } },
            take: 1000,
          },
          serviceGoods: {
            include: { good: { select: { name: true, unit: true, salePrice: true } } },
            take: 1000,
          },
        },
      }),
      this.prisma.service.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page, limit };
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    description: string | null;
    price: import('@prisma/client').Prisma.Decimal | null;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    serviceWorks: Array<{
      workId: string;
      quantity: number;
      work: { name: string; normoHours: number; price: import('@prisma/client').Prisma.Decimal };
    }>;
    serviceGoods: Array<{
      goodId: string;
      quantity: number;
      good: { name: string; unit: string; salePrice: import('@prisma/client').Prisma.Decimal };
    }>;
  }): ServiceResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      description: item.description ?? null,
      price: item.price != null ? Number(item.price) : null,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      works: item.serviceWorks.map(sw => ({
        workId: sw.workId,
        workName: sw.work.name,
        normoHours: sw.work.normoHours,
        price: Number(sw.work.price),
        quantity: sw.quantity,
      })),
      goods: item.serviceGoods.map(sg => ({
        goodId: sg.goodId,
        goodName: sg.good.name,
        unit: sg.good.unit,
        salePrice: Number(sg.good.salePrice),
        quantity: sg.quantity,
      })),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
