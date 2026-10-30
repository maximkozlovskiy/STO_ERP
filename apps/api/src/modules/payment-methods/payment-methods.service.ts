import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentSourceType } from '@prisma/client';
import { CASH_METHOD_CODE, isOnlineMethodCode, translateError } from '@sto/shared';
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
type PaymentMethodRow = Omit<
  PaymentMethodResponseDto,
  'defaultDestinationName' | 'defaultDestinationCurrencyCode'
>;

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
  isCash: boolean;
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
    // Ознака пишеться явно й у гілці відновлення: видалений рядок міг мати `isCash: true`, і
    // відновлення з банківським рахунком без ознаки в запиті дало б «готівку» з рахунком (BR-PAY-019).
    const isCash = dto.isCash ?? false;
    const destination =
      (await this.resolveDestination(orgId, isCash, isOnlineMethodCode(dto.code), {
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
        data: { ...fields, isCash, ...destination, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDtoWithName(orgId, restored);
    }
    const item = await this.prisma.paymentMethodConfig.create({
      data: { ...fields, isCash, ...destination, orgId },
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
      select: { id: true, code: true, isSystem: true, isCash: true, defaultSourceType: true },
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
    // BR-PAY-032: ознаку «Готівка» системного способу `cash` не зняти — інакше оплата з каси
    // (`cash-desk`, спосіб `cash`) пішла б у чек ПРРО як безготівкова.
    if (existing.code === CASH_METHOD_CODE && dto.isCash === false) {
      throw new BadRequestException(
        translateError('err.paymentMethod.cashFlagLocked', getLocale()),
      );
    }
    const { defaultSourceType, defaultCashRegisterId, defaultBankAccountId, ...fields } = dto;
    // undefined — призначення в запиті немає, поля лишаються як були.
    const isCash = dto.isCash ?? existing.isCash;
    const destination = await this.resolveDestination(
      orgId,
      isCash,
      isOnlineMethodCode(existing.code),
      {
        defaultSourceType,
        defaultCashRegisterId,
        defaultBankAccountId,
      },
    );
    // BR-PAY-019: ПОЗНАЧИТИ «Готівкою» спосіб, чиї кошти за замовчуванням ідуть на банківський
    // рахунок, — та сама суперечність, що й банківський рахунок для готівки. Рахунок, збережений
    // до правила, інших правок (активність, фіскалізація) не блокує — лише вмикання ознаки.
    if (
      dto.isCash === true &&
      !existing.isCash &&
      destination === undefined &&
      existing.defaultSourceType === PaymentSourceType.BANK_ACCOUNT
    )
      throw new BadRequestException(
        translateError('err.paymentMethod.cashOnlyRegister', getLocale()),
      );
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
   * рахунок чужої організації або видалені → 404. Id іншого типу завжди обнуляється. Онлайн-спосіб
   * (`<шлюз>_qr`) касу призначенням не приймає (400, BR-PAY-031); збережену раніше касу інші правки
   * не чіпають — правило діє лише на призначення в запиті.
   */
  private async resolveDestination(
    orgId: string,
    isCash: boolean,
    online: boolean,
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
      // BR-PAY-031: QR-оплату створює сервер від шлюзу в призначення способу — у касі її гроші
      // не лежать, а фіскальна каса без зміни чи каса іншої валюти зупинила б фіналізацію оплати.
      if (online)
        throw new BadRequestException(
          translateError('err.paymentMethod.onlineBankOnly', getLocale()),
        );
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
    // BR-PAY-019: готівка лягає лише в касу — банківський рахунок за замовчуванням зробив би
    // кожну оплату готівкою без явної каси відмовою (рішення власника 2026-10-14).
    if (isCash)
      throw new BadRequestException(
        translateError('err.paymentMethod.cashOnlyRegister', getLocale()),
      );
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
            select: { id: true, name: true, currency: { select: { code: true } } },
            take: cashIds.length,
          })
        : Promise.resolve([]),
      bankIds.length
        ? this.prisma.bankAccount.findMany({
            where: { id: { in: bankIds }, orgId, deletedAt: null },
            select: { id: true, name: true, currency: { select: { code: true } } },
            take: bankIds.length,
          })
        : Promise.resolve([]),
    ]);
    // Назва і валюта: валюту вікно оплати звіряє з валютою рахунку, коли касу за замовчуванням не
    // видно в його переліку (перші 200 кас за назвою) — інакше пропонувало б касу іншої валюти.
    const cashDest = new Map(registers.map(r => [r.id, r]));
    const bankDest = new Map(accounts.map(a => [a.id, a]));
    return rows.map(r => {
      const dest =
        r.defaultSourceType === PaymentSourceType.CASH_REGISTER && r.defaultCashRegisterId
          ? cashDest.get(r.defaultCashRegisterId)
          : r.defaultSourceType === PaymentSourceType.BANK_ACCOUNT && r.defaultBankAccountId
            ? bankDest.get(r.defaultBankAccountId)
            : undefined;
      return {
        ...r,
        // ?? null — рядок у кеші міг лягти до появи цих полів.
        defaultSourceType: r.defaultSourceType ?? null,
        defaultCashRegisterId: r.defaultCashRegisterId ?? null,
        defaultBankAccountId: r.defaultBankAccountId ?? null,
        defaultDestinationName: dest?.name ?? null,
        defaultDestinationCurrencyCode: dest?.currency?.code ?? null,
      };
    });
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
      isCash: item.isCash,
      defaultSourceType: item.defaultSourceType ?? null,
      defaultCashRegisterId: item.defaultCashRegisterId ?? null,
      defaultBankAccountId: item.defaultBankAccountId ?? null,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
