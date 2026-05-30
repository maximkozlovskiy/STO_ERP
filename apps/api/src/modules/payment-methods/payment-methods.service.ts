import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreatePaymentMethodDto,
  PaymentMethodResponseDto,
  UpdatePaymentMethodDto,
} from './payment-methods.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:payment-methods:${orgId}`;

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<PaymentMethodResponseDto[]> {
    const cached = await this.cache.get<PaymentMethodResponseDto[]>(cacheKey(orgId));
    if (cached) return cached;

    const items = await this.prisma.paymentMethodConfig.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      take: 100,
    });
    const result = items.map(item => this.toDto(item));
    await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<PaymentMethodResponseDto> {
    const item = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Метод оплати не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreatePaymentMethodDto): Promise<PaymentMethodResponseDto> {
    const anyExisting = await this.prisma.paymentMethodConfig.findFirst({
      where: { orgId, code: dto.code },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException(`Метод оплати з кодом "${dto.code}" вже існує`);
      const restored = await this.prisma.paymentMethodConfig.update({
        where: { id: anyExisting.id },
        data: { ...dto, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(restored);
    }
    const item = await this.prisma.paymentMethodConfig.create({ data: { ...dto, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');
    const item = await this.prisma.paymentMethodConfig.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');
    await this.prisma.paymentMethodConfig.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    code: string;
    name: string;
    isActive: boolean;
    sortOrder: number;
    requiresFiscal: boolean;
    updatedAt: Date;
  }): PaymentMethodResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      code: item.code,
      name: item.name,
      isActive: item.isActive,
      sortOrder: item.sortOrder,
      requiresFiscal: item.requiresFiscal,
      updatedAt: item.updatedAt,
    };
  }
}
