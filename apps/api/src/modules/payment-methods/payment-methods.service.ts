import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePaymentMethodDto,
  PaymentMethodResponseDto,
  UpdatePaymentMethodDto,
} from './payment-methods.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<PaymentMethodResponseDto[]> {
    const items = await this.prisma.paymentMethodConfig.findMany({
      where: { orgId },
      orderBy: { sortOrder: 'asc' },
    });
    return items.map(this.toDto);
  }

  async findOne(orgId: string, id: string): Promise<PaymentMethodResponseDto> {
    const item = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId },
    });
    if (!item) throw new NotFoundException('Метод оплати не знайдено');
    return this.toDto(item);
  }

  async create(
    orgId: string,
    dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { orgId, code: dto.code },
    });
    if (existing) {
      throw new ConflictException(
        `Метод оплати з кодом "${dto.code}" вже існує`,
      );
    }

    const item = await this.prisma.paymentMethodConfig.create({
      data: { orgId, ...dto },
    });
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');

    const item = await this.prisma.paymentMethodConfig.update({
      where: { id },
      data: dto,
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');

    // Hard delete — PaymentMethodConfig has no deletedAt (it's a config table)
    await this.prisma.paymentMethodConfig.delete({ where: { id } });
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
