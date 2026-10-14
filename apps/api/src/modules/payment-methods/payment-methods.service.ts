import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentSourceType } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  CreatePaymentMethodDto,
  PaymentMethodResponseDto,
  UpdatePaymentMethodDto,
} from './payment-methods.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:payment-methods:${orgId}`;

/** Рядок способу оплати без назви призначення — так він лежить у кеші. */
type PaymentMethodRow = Omit<PaymentMethodResponseDto, 'defaultDestinationName'>;

/** Куди надходять кошти: три поля, які пишуться завжди разом. */
interface Destination {
  defaultSourceType: PaymentSourceType | null;
  defaultCashRegisterId: string | null;
  defaultBankAccountId: string | null;
}

const NO_DESTINATION: Destination = {
  defaultSourceType: null,
  defaultCashRegisterId: null,
  defaultBankAccountId: null,
};

interface PaymentMethodModel {
  id: string;
  orgId: string;
  code: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  requiresFiscal: boolean;
  defaultSourceType?: PaymentSourceType | null;
  defaultCashRegisterId?: string | null;
  defaultBankAccountId?: string | null;
  updatedAt: Date;
}

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<PaymentMethodResponseDto[]> {
    // У кеші — лише рядки способів: назву каси чи рахунку читаємо щоразу, бо касу можуть
    // перейменувати або видалити в іншому модулі, і кеш способів про це не дізнається.
    let rows = await this.cache.get<PaymentMethodRow[]>(cacheKey(orgId));
    if (!rows) {
      const items = await this.prisma.paymentMethodConfig.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        take: 100,
      });
      rows = items.map(item => this.toRow(item));
      await this.cache.set(cacheKey(orgId), rows, TTL);
    }
    return this.withDestinationNames(orgId, rows);
  }

  async findOne(orgId: string, id: string): Promise<PaymentMethodResponseDto> {
    const item = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item)
      throw new NotFoundException(translateError('err.paymentMethod.notFound', getLocale()));
    return this.toDtoWithName(orgId, item);
  }

  async create(orgId: string, dto: CreatePaymentMethodDto): Promise<PaymentMethodResponseDto> {
    const { defaultSourceType, defaultCashRegisterId, defaultBankAccountId, ...fields } = dto;
    const destination =
      (await this.resolveDestination(orgId, {
        defaultSourceType,
        defaultCashRegisterId,
        defaultBankAccountId,
      })) ?? NO_DESTINATION;
    // sto-optimize: only id + deletedAt consumed (restore-vs-conflict branch).
    const anyExisting = await this.prisma.paymentMethodConfig.findFirst({
      where: { orgId, code: dto.code },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException(
          translateError('err.paymentMethod.codeExists', getLocale(), { code: dto.code }),
        );
      const restored = await this.prisma.paymentMethodConfig.update({
        where: { id: anyExisting.id, orgId },
        data: { ...fields, ...destination, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDtoWithName(orgId, restored);
    }
    const item = await this.prisma.paymentMethodConfig.create({
      data: { ...fields, ...destination, orgId },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDtoWithName(orgId, item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    // Narrow tenant guard — full DTO load марний бо update сам повертає item.
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, isSystem: true },
    });
    if (!existing)
      throw new NotFoundException(translateError('err.paymentMethod.notFound', getLocale()));
    // Системний метод (Готівка/Картка/…) не можна перейменовувати; isActive/sortOrder
    // (деактивація/порядок) лишаються за org (дзеркалить units isSystem — косметика дозволена).
    // code у UpdatePaymentMethodDto відсутній → змінити код неможливо за побудовою.
    if (existing.isSystem && dto.name !== undefined) {
      throw new BadRequestException(
        translateError('err.paymentMethod.systemImmutableName', getLocale()),
      );
    }
    const { defaultSourceType, defaultCashRegisterId, defaultBankAccountId, ...fields } = dto;
    // undefined — призначення в запиті немає, поля лишаються як були.
    const destination = await this.resolveDestination(orgId, {
      defaultSourceType,
      defaultCashRegisterId,
      defaultBankAccountId,
    });
    const item = await this.prisma.paymentMethodConfig.update({
      where: { id, orgId },
      data: { ...fields, ...destination },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDtoWithName(orgId, item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Системний метод оплати не можна видалити.
    const existing = await this.prisma.paymentMethodConfig.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { isSystem: true },
    });
    if (!existing)
      throw new NotFoundException(translateError('err.paymentMethod.notFound', getLocale()));
    if (existing.isSystem) {
      throw new BadRequestException(
        translateError('err.paymentMethod.systemUndeletable', getLocale()),
      );
    }
    const result = await this.prisma.paymentMethodConfig.updateMany({
      where: { id, orgId, deletedAt: null, isSystem: false },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.paymentMethod.notFound', getLocale()));
    await this.cache.del(cacheKey(orgId));
  }

  /**
   * Куди надходять кошти — з полів запиту в три поля моделі, що пишуться разом.
   * `undefined` — запит призначення не чіпає. Тип без явного значення виводиться з переданого id.
   * Каса — лише з `CASH_REGISTER`, рахунок — лише з `BANK_ACCOUNT` (400); тип без id → 400; каса чи
   * рахунок чужої організації або видалені → 404. Id іншого типу завжди обнуляється.
   */
  private async resolveDestination(
    orgId: string,
    input: {
      defaultSourceType?: PaymentSourceType | null;
      defaultCashRegisterId?: string | null;
      defaultBankAccountId?: string | null;
    },
  ): Promise<Destination | undefined> {
    const { defaultCashRegisterId: cashId, defaultBankAccountId: bankId } = input;
    if (input.defaultSourceType === undefined && cashId === undefined && bankId === undefined)
      return undefined;
    const type =
      input.defaultSourceType !== undefined
        ? input.defaultSourceType
        : cashId
          ? PaymentSourceType.CASH_REGISTER
          : bankId
            ? PaymentSourceType.BANK_ACCOUNT
            : null;
    const mismatch = () =>
      new BadRequestException(translateError('err.paymentMethod.destinationMismatch', getLocale()));

    if (type === null) {
      if (cashId || bankId) throw mismatch();
      return NO_DESTINATION;
    }
    if (type === PaymentSourceType.CASH_REGISTER) {
      if (bankId) throw mismatch();
      if (!cashId)
        throw new BadRequestException(
          translateError('err.payment.cashRegisterNotSpecified', getLocale()),
        );
      const reg = await this.prisma.cashRegister.findFirst({
        where: { id: cashId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!reg)
        throw new NotFoundException(
          translateError('err.payment.cashRegisterNotFound', getLocale()),
        );
      return { defaultSourceType: type, defaultCashRegisterId: cashId, defaultBankAccountId: null };
    }
    if (cashId) throw mismatch();
    if (!bankId)
      throw new BadRequestException(
        translateError('err.payment.bankAccountNotSpecified', getLocale()),
      );
    const acc = await this.prisma.bankAccount.findFirst({
      where: { id: bankId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!acc)
      throw new NotFoundException(translateError('err.payment.bankAccountNotFound', getLocale()));
    return { defaultSourceType: type, defaultCashRegisterId: null, defaultBankAccountId: bankId };
  }

  /**
   * Назви кас і рахунків-призначень для списку — двома запитами на весь список (не N+1).
   * Видалена каса чи рахунок назви не дають: таблиця покаже, що призначення фактично немає.
   */
  private async withDestinationNames(
    orgId: string,
    rows: PaymentMethodRow[],
  ): Promise<PaymentMethodResponseDto[]> {
    const cashIds = [
      ...new Set(rows.map(r => r.defaultCashRegisterId).filter((v): v is string => !!v)),
    ];
    const bankIds = [
      ...new Set(rows.map(r => r.defaultBankAccountId).filter((v): v is string => !!v)),
    ];
    const [registers, accounts] = await Promise.all([
      cashIds.length
        ? this.prisma.cashRegister.findMany({
            where: { id: { in: cashIds }, orgId, deletedAt: null },
            select: { id: true, name: true },
            take: cashIds.length,
          })
        : Promise.resolve([]),
      bankIds.length
        ? this.prisma.bankAccount.findMany({
            where: { id: { in: bankIds }, orgId, deletedAt: null },
            select: { id: true, name: true },
            take: bankIds.length,
          })
        : Promise.resolve([]),
    ]);
    const cashName = new Map(registers.map(r => [r.id, r.name]));
    const bankName = new Map(accounts.map(a => [a.id, a.name]));
    return rows.map(r => ({
      ...r,
      // ?? null — рядок у кеші міг лягти до появи цих полів.
      defaultSourceType: r.defaultSourceType ?? null,
      defaultCashRegisterId: r.defaultCashRegisterId ?? null,
      defaultBankAccountId: r.defaultBankAccountId ?? null,
      defaultDestinationName:
        r.defaultSourceType === PaymentSourceType.CASH_REGISTER && r.defaultCashRegisterId
          ? (cashName.get(r.defaultCashRegisterId) ?? null)
          : r.defaultSourceType === PaymentSourceType.BANK_ACCOUNT && r.defaultBankAccountId
            ? (bankName.get(r.defaultBankAccountId) ?? null)
            : null,
    }));
  }

  private async toDtoWithName(
    orgId: string,
    item: PaymentMethodModel,
  ): Promise<PaymentMethodResponseDto> {
    const [dto] = await this.withDestinationNames(orgId, [this.toRow(item)]);
    return dto;
  }

  private toRow(item: PaymentMethodModel): PaymentMethodRow {
    return {
      id: item.id,
      orgId: item.orgId,
      code: item.code,
      name: item.name,
      isActive: item.isActive,
      isSystem: item.isSystem,
      sortOrder: item.sortOrder,
      requiresFiscal: item.requiresFiscal,
      defaultSourceType: item.defaultSourceType ?? null,
      defaultCashRegisterId: item.defaultCashRegisterId ?? null,
      defaultBankAccountId: item.defaultBankAccountId ?? null,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
