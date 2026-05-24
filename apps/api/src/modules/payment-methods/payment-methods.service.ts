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
      where: { orgId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
    return items.map(item => this.toDto(item));
  }

  async findOne(orgId: string, id: string): Promise<PaymentMethodResponseDto> {
    const item = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Метод оплати не знайдено');
    return this.toDto(item);
  }

  async create(
    orgId: string,
    dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { orgId, code: dto.code, deletedAt: null },
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
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');

    const item = await this.prisma.paymentMethodConfig.update({
      where: { id, orgId },
      data: dto,
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Метод оплати не знайдено');
    await this.prisma.paymentMethodConfig.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
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
