import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { calculatePagination } from '../../common/utils/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { SettlementsService } from '../settlements/settlements.service';
import {
  CreateSupplierPaymentDto,
  UpdateSupplierPaymentDto,
  SupplierPaymentResponseDto,
  PaginatedSupplierPaymentsDto,
} from './supplier-payments.dto';

type SPStatus = SupplierPaymentStatus;

const SP_TRANSITIONS: Record<SPStatus, SPStatus[]> = {
  DRAFT: [SupplierPaymentStatus.CONFIRMED, SupplierPaymentStatus.CANCELLED],
  CONFIRMED: [],
  CANCELLED: [],
};

@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: SPStatus,
    supplierId?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<PaginatedSupplierPaymentsDto> {
    const where: Prisma.SupplierPaymentWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status;
    if (supplierId) {
      // cross-tenant guard: постачальник має належати цій org
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: supplierId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!cp) throw new NotFoundException('Постачальника не знайдено');
      where.supplierId = supplierId;
    }
    if (q) {
      const like = q.trim();
      if (like.length > 0) {
        where.OR = [
          { number: { contains: like, mode: 'insensitive' } },
          {
            supplier: {
              OR: [
                { companyName: { contains: like, mode: 'insensitive' } },
                { lastName: { contains: like, mode: 'insensitive' } },
                { firstName: { contains: like, mode: 'insensitive' } },
              ],
            },
          },
        ];
      }
    }
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page, limit });
    const [items, total] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          bankAccount: { select: { name: true } },
          cashRegister: { select: { name: true } },
          purchaseOrder: { select: { number: true } },
        },
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        bankAccount: { select: { name: true } },
        cashRegister: { select: { name: true } },
        purchaseOrder: { select: { number: true } },
      },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    return this.toDto(sp);
  }

  async create(
    orgId: string,
    dto: CreateSupplierPaymentDto,
    userId?: string,
  ): Promise<SupplierPaymentResponseDto> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void userId;
    this.assertSourceConsistency(dto.sourceType, dto.bankAccountId, dto.cashRegisterId);

    // Паралельна валідація незалежних FK: постачальник + джерело коштів + PO.
    const [supplier, bankAccount, cashRegister, purchaseOrder] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.supplierId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      dto.bankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: dto.bankAccountId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.cashRegisterId
        ? this.prisma.cashRegister.findFirst({
            where: { id: dto.cashRegisterId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, supplierId: true },
          })
        : Promise.resolve(null),
    ]);

    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (supplier.type === 'CLIENT') {
      throw new BadRequestException('Контрагент не є постачальником');
    }
    if (dto.bankAccountId && !bankAccount) {
      throw new NotFoundException('Банківський рахунок не знайдено');
    }
    if (dto.cashRegisterId && !cashRegister) {
      throw new NotFoundException('Касу не знайдено');
    }
    if (dto.purchaseOrderId) {
      if (!purchaseOrder) throw new NotFoundException('Замовлення постачальнику не знайдено');
      if (purchaseOrder.supplierId !== dto.supplierId) {
        throw new BadRequestException('Замовлення не належить вказаному постачальнику');
      }
    }

    const number = await this.docNumbers.next(orgId, 'SUPPLIER_PAYMENT');

    const sp = await this.prisma.supplierPayment.create({
      data: {
        orgId,
        supplierId: dto.supplierId,
        purchaseOrderId: dto.purchaseOrderId ?? null,
        sourceType: dto.sourceType,
        bankAccountId: dto.sourceType === PaymentSourceType.BANK_ACCOUNT ? dto.bankAccountId : null,
        cashRegisterId:
          dto.sourceType === PaymentSourceType.CASH_REGISTER ? dto.cashRegisterId : null,
        number,
        amount: dto.amount,
        method: dto.method,
        notes: dto.notes ?? null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
      },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        bankAccount: { select: { name: true } },
        cashRegister: { select: { name: true } },
        purchaseOrder: { select: { number: true } },
      },
    });

    return this.toDto(sp);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateSupplierPaymentDto,
  ): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true,
        status: true,
        supplierId: true,
        sourceType: true,
        bankAccountId: true,
        cashRegisterId: true,
        purchaseOrderId: true,
      },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    if (sp.status !== SupplierPaymentStatus.DRAFT) {
      throw new BadRequestException('Редагування дозволено лише у статусі "Чернетка"');
    }

    const nextSupplierId = dto.supplierId ?? sp.supplierId;
    // Bug #588 — paired FK invariant: якщо supplier змінюється БЕЗ явного нового purchaseOrderId,
    // а існуючий PO належав старому постачальнику, автоматично чистимо `purchaseOrderId`.
    // Дзеркалить UX-логіку `SupplierPaymentCreateModal` (onSelect(supplier) → clear PO pair) —
    // без цього API-only client (Postman/sync/mobile) створює orphan cross-supplier linkage.
    const supplierChanged = dto.supplierId !== undefined && dto.supplierId !== sp.supplierId;
    const shouldClearOrphanPO =
      supplierChanged && dto.purchaseOrderId === undefined && sp.purchaseOrderId !== null;
    const nextSourceType = dto.sourceType ?? sp.sourceType;
    // Ефективні поля джерела після застосування патчу — валідуємо консистентність.
    const nextBankAccountId =
      dto.bankAccountId !== undefined ? dto.bankAccountId : sp.bankAccountId;
    const nextCashRegisterId =
      dto.cashRegisterId !== undefined ? dto.cashRegisterId : sp.cashRegisterId;
    this.assertSourceConsistency(
      nextSourceType,
      nextSourceType === PaymentSourceType.BANK_ACCOUNT
        ? (nextBankAccountId ?? undefined)
        : undefined,
      nextSourceType === PaymentSourceType.CASH_REGISTER
        ? (nextCashRegisterId ?? undefined)
        : undefined,
    );

    const [supplier, bankAccount, cashRegister, purchaseOrder] = await Promise.all([
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true, type: true },
          })
        : Promise.resolve(null),
      nextSourceType === PaymentSourceType.BANK_ACCOUNT && nextBankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: nextBankAccountId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      nextSourceType === PaymentSourceType.CASH_REGISTER && nextCashRegisterId
        ? this.prisma.cashRegister.findFirst({
            where: { id: nextCashRegisterId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, supplierId: true },
          })
        : Promise.resolve(null),
    ]);

    if (dto.supplierId) {
      if (!supplier) throw new NotFoundException('Постачальника не знайдено');
      if (supplier.type === 'CLIENT')
        throw new BadRequestException('Контрагент не є постачальником');
    }
    if (nextSourceType === PaymentSourceType.BANK_ACCOUNT && nextBankAccountId && !bankAccount) {
      throw new NotFoundException('Банківський рахунок не знайдено');
    }
    if (nextSourceType === PaymentSourceType.CASH_REGISTER && nextCashRegisterId && !cashRegister) {
      throw new NotFoundException('Касу не знайдено');
    }
    if (dto.purchaseOrderId) {
      if (!purchaseOrder) throw new NotFoundException('Замовлення постачальнику не знайдено');
      if (purchaseOrder.supplierId !== nextSupplierId) {
        throw new BadRequestException('Замовлення не належить вказаному постачальнику');
      }
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: {
        ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
        ...(dto.sourceType ? { sourceType: dto.sourceType } : {}),
        // Джерело перезаписуємо узгоджено з ефективним sourceType.
        bankAccountId:
          nextSourceType === PaymentSourceType.BANK_ACCOUNT ? (nextBankAccountId ?? null) : null,
        cashRegisterId:
          nextSourceType === PaymentSourceType.CASH_REGISTER ? (nextCashRegisterId ?? null) : null,
        ...(dto.purchaseOrderId !== undefined
          ? { purchaseOrderId: dto.purchaseOrderId || null }
          : shouldClearOrphanPO
            ? { purchaseOrderId: null }
            : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.method !== undefined ? { method: dto.method } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.documentDate ? { documentDate: new Date(dto.documentDate) } : {}),
      },
    });

    return this.findOne(orgId, id);
  }

  async confirm(orgId: string, id: string, userId: string): Promise<SupplierPaymentResponseDto> {
    const pre = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!pre) throw new NotFoundException('Оплату не знайдено');

    const allowed = SP_TRANSITIONS[pre.status];
    if (!allowed.includes(SupplierPaymentStatus.CONFIRMED)) {
      throw new BadRequestException(`Неможливо провести оплату зі статусу "${pre.status}"`);
    }

    await this.prisma.$transaction(
      async tx => {
        // FSM auto-transition у tx → re-read entity + перевірка status === expected.
        // Без цього два concurrent confirm() дадуть подвійний settlement PAYMENT.
        const sp = await tx.supplierPayment.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { status: true, supplierId: true, amount: true },
        });
        if (!sp) throw new NotFoundException('Оплату не знайдено');
        if (sp.status !== SupplierPaymentStatus.DRAFT) {
          throw new BadRequestException(`Неможливо провести оплату зі статусу "${sp.status}"`);
        }

        // Оплата постачальнику: ми надсилаємо йому кошти → наш борг зменшується.
        // Семантика — PAYMENT (BALANCE_SIGN = -1). Без Checkbox і лояльності —
        // фіскалізація й бонуси стосуються лише клієнтських оплат.
        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: sp.supplierId,
            type: 'PAYMENT',
            amount: Number(sp.amount),
            documentType: 'SupplierPayment',
            documentId: id,
            createdBy: userId,
          },
          tx,
        );

        await tx.supplierPayment.update({
          where: { id, orgId },
          data: { status: SupplierPaymentStatus.CONFIRMED },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.findOne(orgId, id);
  }

  async cancel(orgId: string, id: string): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');

    const allowed = SP_TRANSITIONS[sp.status];
    if (!allowed.includes(SupplierPaymentStatus.CANCELLED)) {
      throw new BadRequestException(`Неможливо скасувати оплату зі статусу "${sp.status}"`);
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: { status: SupplierPaymentStatus.CANCELLED },
    });

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    if (sp.status === SupplierPaymentStatus.CONFIRMED) {
      throw new BadRequestException('Проведену оплату видалити неможливо');
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Гарантує, що заповнене рівно одне джерело коштів відповідно до sourceType:
   * BANK_ACCOUNT → потрібен bankAccountId (без cashRegisterId);
   * CASH_REGISTER → потрібен cashRegisterId (без bankAccountId).
   */
  private assertSourceConsistency(
    sourceType: PaymentSourceType,
    bankAccountId?: string,
    cashRegisterId?: string,
  ): void {
    if (sourceType === PaymentSourceType.BANK_ACCOUNT) {
      if (!bankAccountId) {
        throw new BadRequestException('Для оплати з банку потрібно вказати банківський рахунок');
      }
      if (cashRegisterId) {
        throw new BadRequestException('Не можна одночасно вказувати банківський рахунок і касу');
      }
    } else {
      if (!cashRegisterId) {
        throw new BadRequestException('Для оплати з каси потрібно вказати касу');
      }
      if (bankAccountId) {
        throw new BadRequestException('Не можна одночасно вказувати банківський рахунок і касу');
      }
    }
  }

  private toDto(sp: {
    id: string;
    orgId: string;
    number: string;
    status: SupplierPaymentStatus;
    supplierId: string;
    sourceType: PaymentSourceType;
    bankAccountId: string | null;
    cashRegisterId: string | null;
    purchaseOrderId: string | null;
    amount: Prisma.Decimal | number;
    method: string;
    notes: string | null;
    documentDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    supplier?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    bankAccount?: { name: string } | null;
    cashRegister?: { name: string } | null;
    purchaseOrder?: { number: string } | null;
  }): SupplierPaymentResponseDto {
    const sup = sp.supplier;
    const supplierName =
      formatPersonName(sup?.lastName, sup?.firstName, sup?.companyName) || undefined;
    const sourceName =
      sp.sourceType === PaymentSourceType.BANK_ACCOUNT
        ? (sp.bankAccount?.name ?? null)
        : (sp.cashRegister?.name ?? null);
    return {
      id: sp.id,
      orgId: sp.orgId,
      number: sp.number,
      status: sp.status,
      supplierId: sp.supplierId,
      supplierName,
      sourceType: sp.sourceType,
      bankAccountId: sp.bankAccountId ?? null,
      cashRegisterId: sp.cashRegisterId ?? null,
      sourceName,
      purchaseOrderId: sp.purchaseOrderId ?? null,
      purchaseOrderNumber: sp.purchaseOrder?.number ?? null,
      amount: Number(sp.amount),
      method: sp.method,
      notes: sp.notes ?? null,
      documentDate: sp.documentDate ? sp.documentDate.toISOString().slice(0, 10) : null,
      createdAt: sp.createdAt instanceof Date ? sp.createdAt.toISOString() : sp.createdAt,
      updatedAt: sp.updatedAt instanceof Date ? sp.updatedAt.toISOString() : sp.updatedAt,
      deletedAt: sp.deletedAt instanceof Date ? sp.deletedAt.toISOString() : (sp.deletedAt ?? null),
    };
  }
}
