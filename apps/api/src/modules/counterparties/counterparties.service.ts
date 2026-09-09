import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ContractType, CounterpartyType, LegalForm, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { calculatePagination } from '../../common/utils/pagination';
import { initCountsMap } from '../../common/utils/linked-counts';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import {
  ContractResponseDto,
  CounterpartyQueryDto,
  CounterpartyResponseDto,
  CreateContractDto,
  CreateCounterpartyDto,
  CreateGarageDto,
  GarageResponseDto,
  PaginatedCounterpartiesDto,
  UpdateContractDto,
  UpdateCounterpartyDto,
} from './counterparties.dto';

// «Назва» контрагента обов'язкова, але гнучко: має бути companyName АБО firstName/lastName.
// Cross-field guard — DTO не може це виразити через @IsOptional на кожному полі окремо.
function hasCounterpartyName(v: {
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): boolean {
  return !!(v.companyName?.trim() || v.firstName?.trim() || v.lastName?.trim());
}

@Injectable()
export class CounterpartiesService {
  private readonly logger = new Logger(CounterpartiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentNumberService: DocumentNumberService,
    private readonly audit: AuditService,
  ) {}

  async findAll(orgId: string, query: CounterpartyQueryDto): Promise<PaginatedCounterpartiesDto> {
    // types[] wins over type (single), supports ?types=SUPPLIER,BOTH
    const typeFilter = query.types?.length
      ? { type: { in: query.types } }
      : query.type
        ? { type: query.type }
        : {};

    const where = {
      orgId,
      ...(query.showDeleted ? {} : { deletedAt: null }),
      ...typeFilter,
      ...(query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' as const } },
              { lastName: { contains: query.q, mode: 'insensitive' as const } },
              { companyName: { contains: query.q, mode: 'insensitive' as const } },
              { phone: { contains: query.q } },
              { edrpou: { contains: query.q } },
              // Search by vehicle license plate — user looks up client by car number
              {
                customerGarages: {
                  some: {
                    deletedAt: null,
                    vehicles: {
                      some: {
                        deletedAt: null,
                        licensePlate: { contains: query.q, mode: 'insensitive' as const },
                      },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const [items, total] = await Promise.all([
      this.prisma.counterparty.findMany({
        where,
        include: { settlementAccount: { select: { balance: true } } },
        orderBy:
          query.sortBy === 'createdAt'
            ? [{ createdAt: query.sortDir === 'asc' ? 'asc' : 'desc' }]
            : query.sortBy === 'balance'
              ? [{ settlementAccount: { balance: query.sortDir === 'asc' ? 'asc' : 'desc' } }]
              : [{ lastName: query.sortDir === 'desc' ? 'desc' : 'asc' }, { companyName: 'asc' }],
        skip,
        take,
      }),
      this.prisma.counterparty.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page: query.page,
      limit: query.limit,
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

  async create(
    orgId: string,
    dto: CreateCounterpartyDto,
    userId?: string,
  ): Promise<CounterpartyResponseDto> {
    if (!hasCounterpartyName(dto)) {
      throw new BadRequestException('Вкажіть назву компанії або ім’я/прізвище контрагента');
    }
    // Pre-allocate contract number via DocumentNumberService BEFORE entering the main $transaction.
    // next() uses its own $transaction with SELECT FOR UPDATE — nesting transactions would deadlock or hide the lock.
    const needsContract = dto.type === 'SUPPLIER' || dto.type === 'BOTH';
    // Auto-create PURCHASE contract must use org-level currency (Settings → Org → «Валюта обліку»),
    // not hardcoded 'UAH' — breaks the documented invariant for orgs with non-UAH default currency.
    // Fallback to 'UAH' if settings row missing (fresh org). Both lookups are independent → Promise.all (-1 RTT).
    const [contractNumber, orgSettingsRow] = await Promise.all([
      needsContract
        ? this.documentNumberService.next(orgId, 'COUNTERPARTY_AGREEMENT')
        : Promise.resolve(null),
      needsContract
        ? this.prisma.organisationSettings.findUnique({
            where: { orgId },
            select: { currency: true },
          })
        : Promise.resolve(null),
    ]);
    const orgCurrency = orgSettingsRow?.currency ?? 'UAH';

    const item = await this.prisma.$transaction(
      async tx => {
        const cp = await tx.counterparty.create({ data: { ...dto, orgId } });
        // Auto-create settlement account
        await tx.settlementAccount.create({
          data: { orgId, counterpartyId: cp.id, balance: 0 },
        });
        // Auto-create default garage for clients
        if (dto.type === 'CLIENT' || dto.type === 'BOTH') {
          await tx.customerGarage.create({
            data: {
              orgId,
              counterpartyId: cp.id,
              name: 'Основний',
              isDefault: true,
            },
          });
        }
        // Auto-create primary PURCHASE contract for suppliers — currencyCode inherited from org settings.
        if (needsContract && contractNumber) {
          await tx.counterpartyContract.create({
            data: {
              orgId,
              counterpartyId: cp.id,
              number: contractNumber,
              contractType: ContractType.PURCHASE,
              startDate: new Date(),
              isPrimary: true,
              currencyCode: orgCurrency,
            },
          });
        }
        return tx.counterparty.findFirstOrThrow({
          where: { id: cp.id, orgId, deletedAt: null },
          include: { settlementAccount: { select: { balance: true } } },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    // C1b: аудит створення контрагента («хто завів клієнта/постачальника»). Best-effort post-commit.
    if (userId) {
      this.audit
        .record(orgId, 'Counterparty', item.id, 'CREATE', userId, undefined, {
          type: dto.type,
          companyName: dto.companyName ?? null,
          firstName: dto.firstName ?? null,
          lastName: dto.lastName ?? null,
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateCounterpartyDto,
    userId?: string,
  ): Promise<CounterpartyResponseDto> {
    // Tenant guard + before-snapshot для аудиту. Bug #719: раніше select тягнув лише
    // {id,companyName,firstName,lastName} → аудит-diff порівнював цей звужений знімок з dto,
    // де решта полів = undefined → фейкові «companyName→undefined»/«id→undefined» записи.
    // Тягнемо повний набір auditable-полів (усі редаговані UpdateCounterpartyDto), щоб diff
    // рахувався коректно (справжнє from→to) і був знімком САМЕ ДО зміни.
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        companyName: true,
        firstName: true,
        lastName: true,
        edrpou: true,
        vatPayer: true,
        phone: true,
        email: true,
        notes: true,
        legalForm: true,
        legalAddress: true,
        actualAddress: true,
        bankAccount: true,
        bankName: true,
        contactPerson: true,
        taxNumber: true,
      },
    });
    if (!existing) throw new NotFoundException('Контрагента не знайдено');
    // Merged-стан: PATCH частковий → перевіряємо результат після застосування dto
    // (undefined = не чіпаємо, лишається наявне; '' = очищення).
    const merged = {
      companyName: dto.companyName !== undefined ? dto.companyName : existing.companyName,
      firstName: dto.firstName !== undefined ? dto.firstName : existing.firstName,
      lastName: dto.lastName !== undefined ? dto.lastName : existing.lastName,
    };
    if (!hasCounterpartyName(merged)) {
      throw new BadRequestException('Вкажіть назву компанії або ім’я/прізвище контрагента');
    }
    const item = await this.prisma.counterparty.update({
      where: { id, orgId },
      data: dto,
      include: { settlementAccount: { select: { balance: true } } },
    });
    // C1b: аудит редагування — diff обчислює AuditService (old=знімок ДО зміни, new=dto).
    // Bug #719: old-snapshot обмежуємо РІВНО ключами, що присутні у dto — інакше buildDiff
    // зарахував би поля, яких PATCH не чіпав (existing має значення, dto — undefined), як
    // «очищені до undefined». Тепер old містить справжні попередні значення саме змінених полів.
    if (userId) {
      const oldSnapshot: Record<string, unknown> = {};
      for (const k of Object.keys(dto)) {
        if (k in existing) oldSnapshot[k] = (existing as Record<string, unknown>)[k];
      }
      this.audit
        .record(
          orgId,
          'Counterparty',
          id,
          'UPDATE',
          userId,
          oldSnapshot,
          dto as Record<string, unknown>,
        )
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }
    return this.toDto(item, true);
  }

  async remove(orgId: string, id: string, userId?: string): Promise<void> {
    // MD-H1: не видаляти контрагента з непогашеним боргом або активними документами —
    // інакше борг «зникає» зі списку, а наряди/PO осиротіють на soft-deleted контрагента.
    const cp = await this.prisma.counterparty.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { settlementAccount: { select: { balance: true } } },
    });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (cp.settlementAccount && Number(cp.settlementAccount.balance) !== 0) {
      throw new BadRequestException(
        'Неможливо видалити контрагента з ненульовим балансом (є заборгованість)',
      );
    }
    // Активні (не-фінальні) наряди / незакриті замовлення / відкриті рахунки блокують видалення.
    // Bug #631: рахунки — той самий клас документів що наряди/PO. SENT/OVERDUE ловить balance-guard
    // (вони створили CHARGE), АЛЕ DRAFT-рахунок ще не має транзакції → balance=0 → осиротів би на
    // soft-deleted контрагента (лишається активним у списку рахунків з мертвим контрагентом).
    const [activeWo, openPo, openInvoice] = await Promise.all([
      this.prisma.workOrder.count({
        where: {
          orgId,
          counterpartyId: id,
          deletedAt: null,
          status: { notIn: ['ARCHIVED', 'CANCELLED'] },
        },
      }),
      this.prisma.purchaseOrder.count({
        where: {
          orgId,
          supplierId: id,
          deletedAt: null,
          status: { notIn: ['RECEIVED', 'CANCELLED'] },
        },
      }),
      this.prisma.invoice.count({
        where: {
          orgId,
          counterpartyId: id,
          deletedAt: null,
          status: { notIn: ['PAID', 'CANCELLED'] },
        },
      }),
    ]);
    if (activeWo > 0) {
      throw new BadRequestException('Неможливо видалити: контрагент має активні наряди');
    }
    if (openPo > 0) {
      throw new BadRequestException('Неможливо видалити: контрагент має незакриті замовлення');
    }
    if (openInvoice > 0) {
      throw new BadRequestException('Неможливо видалити: контрагент має відкриті рахунки');
    }

    // sto-optimize: atomic updateMany with compound where — no race window between guard and write.
    const result = await this.prisma.counterparty.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Контрагента не знайдено');
    // C1b: аудит видалення (soft-delete) контрагента.
    if (userId) {
      this.audit
        .record(orgId, 'Counterparty', id, 'DELETE', userId, { deletedAt: null }, undefined)
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }
  }

  // ─── Garages ─────────────────────────────────────────────

  async findGarages(orgId: string, counterpartyId: string): Promise<GarageResponseDto[]> {
    // Parallel parent guard + child list — independent tenant-safe reads (-1 RTT).
    const [cp, items] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.customerGarage.findMany({
        where: { counterpartyId, orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        take: 50,
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    return items.map(item => this.toGarageDto(item));
  }

  async createGarage(
    orgId: string,
    counterpartyId: string,
    dto: CreateGarageDto,
  ): Promise<GarageResponseDto> {
    // sto-optimize: narrow tenant guard (id-only select) замість findOne що тягне
    // повний Counterparty + settlementAccount include. Existence лише потрібна.
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    // Інваріант: лише один гараж може бути default per counterparty.
    // updateMany(isDefault→false) є no-op коли нема default-гаражу або isDefault=false передано.
    const item = await this.prisma.$transaction(
      async tx => {
        if (dto.isDefault === true) {
          await tx.customerGarage.updateMany({
            where: { orgId, counterpartyId, isDefault: true, deletedAt: null },
            data: { isDefault: false },
          });
        }
        return tx.customerGarage.create({
          data: { orgId, counterpartyId, ...dto },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.toGarageDto(item);
  }

  async removeGarage(orgId: string, counterpartyId: string, garageId: string): Promise<void> {
    // Parallel parent (counterparty) guard + child (garage) tenant-scoped fetch (-1 RTT).
    // select.isDefault — needed to auto-promote next sibling when deleting the default garage.
    const [cp, garage] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.customerGarage.findFirst({
        where: { id: garageId, counterpartyId, orgId, deletedAt: null },
        select: { id: true, isDefault: true },
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (!garage) throw new NotFoundException('Гараж не знайдено');
    // Auto-promote the oldest active sibling as new default — otherwise the invariant
    // «counterparty always has a default garage» is silently broken.
    await this.prisma.$transaction(
      async tx => {
        await tx.customerGarage.update({
          where: { id: garageId, orgId },
          data: { deletedAt: new Date() },
        });
        if (garage.isDefault) {
          const nextSibling = await tx.customerGarage.findFirst({
            where: {
              orgId,
              counterpartyId,
              deletedAt: null,
              id: { not: garageId },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (nextSibling) {
            await tx.customerGarage.update({
              where: { id: nextSibling.id, orgId },
              data: { isDefault: true },
            });
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  // ─── Contracts ───────────────────────────────────────────

  private validateContractType(cpType: CounterpartyType, contractType: ContractType): void {
    if (cpType === CounterpartyType.SUPPLIER && contractType === ContractType.SALE)
      throw new BadRequestException('Постачальник може мати лише договір Купівлі');
    if (cpType === CounterpartyType.CLIENT && contractType === ContractType.PURCHASE)
      throw new BadRequestException('Клієнт може мати лише договір Продажу');
  }

  async findContracts(
    orgId: string,
    counterpartyId: string,
    showDeleted = false,
  ): Promise<ContractResponseDto[]> {
    const [cp, items] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      // findMany without take is OOM risk. 200 is generous —
      // realistic contract count per counterparty is <10.
      // showDeleted: показує soft-deleted договори (форма контрагента, галка).
      this.prisma.counterpartyContract.findMany({
        where: { counterpartyId, orgId, ...(showDeleted ? {} : { deletedAt: null }) },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: 200,
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    return items.map(c => this.toContractDto(c));
  }

  async restoreContract(
    orgId: string,
    counterpartyId: string,
    contractId: string,
  ): Promise<ContractResponseDto> {
    // Bug #603: parent-CP guard — дзеркалить прекчеки findContracts/create/update/removeContract.
    // Без цього silent orphan: contract.deletedAt=null, counterparty.deletedAt=not-null →
    // договір видно через прямий GET, але список для CP повертає 404 (Контрагента не знайдено).
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    // Atomic updateMany з `NOT: { deletedAt: null }` (еталон brands.service.restore).
    // isPrimary → false при відновленні: інакше можливий ДРУГИЙ головний того ж
    // contractType (якщо за час видалення інший став головним). Користувач за потреби
    // робить відновлений головним вручну — уникаємо дубля-primary без зайвого запиту.
    const result = await this.prisma.counterpartyContract.updateMany({
      where: { id: contractId, counterpartyId, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null, isPrimary: false },
    });
    if (result.count === 0) throw new NotFoundException('Видалений договір не знайдено');
    const contract = await this.prisma.counterpartyContract.findFirstOrThrow({
      where: { id: contractId, orgId },
    });
    return this.toContractDto(contract);
  }

  async createContract(
    orgId: string,
    counterpartyId: string,
    dto: CreateContractDto,
  ): Promise<ContractResponseDto> {
    // isPrimary is scoped PER contractType — a BOTH-type counterparty can have one primary PURCHASE
    // and one primary SALE simultaneously. Swapping across both types broke the auto-PURCHASE invariant.
    // currencyCode is a raw string without a DB FK — must validate it exists in Currency table
    // (same as Settings.updateOrganisationSettings). Without guard, `currencyCode: 'XYZ'` is saved
    // silently → UX broken in invoices (`'1 000.00 XYZ'`) + downstream FX calculations fail.
    const [cp, sameTypeCount, currencyExists] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.counterpartyContract.count({
        where: { counterpartyId, orgId, deletedAt: null, contractType: dto.contractType },
      }),
      dto.currencyCode !== undefined
        ? this.prisma.currency.findFirst({
            where: { orgId, code: dto.currencyCode, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (dto.currencyCode !== undefined && !currencyExists) {
      throw new BadRequestException(`Валюта з кодом "${dto.currencyCode}" не знайдена`);
    }
    this.validateContractType(cp.type, dto.contractType);

    const number =
      dto.number ?? (await this.documentNumberService.next(orgId, 'COUNTERPARTY_AGREEMENT'));
    const makePrimary = sameTypeCount === 0 || dto.isPrimary === true;

    const contract = await this.prisma.$transaction(
      async tx => {
        if (makePrimary) {
          await tx.counterpartyContract.updateMany({
            where: {
              counterpartyId,
              orgId,
              deletedAt: null,
              contractType: dto.contractType,
            },
            data: { isPrimary: false },
          });
        }
        return tx.counterpartyContract.create({
          data: {
            orgId,
            counterpartyId,
            number,
            contractType: dto.contractType,
            startDate: new Date(dto.startDate),
            endDate: dto.endDate ? new Date(dto.endDate) : null,
            isPrimary: makePrimary,
            creditLimit: dto.creditLimit ?? null,
            currencyCode: dto.currencyCode ?? 'UAH',
            paymentDeferDays: dto.paymentDeferDays ?? null,
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.toContractDto(contract);
  }

  async updateContract(
    orgId: string,
    counterpartyId: string,
    contractId: string,
    dto: UpdateContractDto,
  ): Promise<ContractResponseDto> {
    // Paired currencyCode guard for PATCH — without it a PATCH can substitute an invalid code
    // even if createContract blocks it. Runs in parallel with cp + contract lookups.
    const [cp, contract, currencyExists] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.counterpartyContract.findFirst({
        where: { id: contractId, counterpartyId, orgId, deletedAt: null },
        select: { contractType: true },
      }),
      dto.currencyCode !== undefined
        ? this.prisma.currency.findFirst({
            where: { orgId, code: dto.currencyCode, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (!contract) throw new NotFoundException('Договір не знайдено');
    if (dto.currencyCode !== undefined && !currencyExists) {
      throw new BadRequestException(`Валюта з кодом "${dto.currencyCode}" не знайдена`);
    }

    if (dto.contractType) {
      this.validateContractType(cp.type, dto.contractType);
    }

    // Scope isPrimary swap to SAME contractType only — otherwise setting a SALE contract as primary
    // would unset primary on PURCHASE contracts.
    const swapType = dto.contractType ?? contract.contractType;

    const updated = await this.prisma.$transaction(
      async tx => {
        if (dto.isPrimary === true) {
          await tx.counterpartyContract.updateMany({
            where: {
              counterpartyId,
              orgId,
              deletedAt: null,
              contractType: swapType,
              id: { not: contractId },
            },
            data: { isPrimary: false },
          });
        }
        return tx.counterpartyContract.update({
          where: { id: contractId, orgId },
          data: {
            ...(dto.number !== undefined && { number: dto.number }),
            ...(dto.contractType !== undefined && { contractType: dto.contractType }),
            ...(dto.startDate !== undefined && { startDate: new Date(dto.startDate) }),
            ...(dto.endDate !== undefined && {
              endDate: dto.endDate ? new Date(dto.endDate) : null,
            }),
            ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
            ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
            ...(dto.currencyCode !== undefined && { currencyCode: dto.currencyCode }),
            ...(dto.paymentDeferDays !== undefined && { paymentDeferDays: dto.paymentDeferDays }),
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.toContractDto(updated);
  }

  async removeContract(orgId: string, counterpartyId: string, contractId: string): Promise<void> {
    // Read contractType + isPrimary to count only same-type contracts for SUPPLIER guard
    // and auto-promote next primary after deleting the current primary.
    const [cp, contract] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.counterpartyContract.findFirst({
        where: { id: contractId, counterpartyId, orgId, deletedAt: null },
        select: { id: true, contractType: true, isPrimary: true },
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (!contract) throw new NotFoundException('Договір не знайдено');

    // Guard + soft-delete + auto-promote must be atomic. Counting OUTSIDE the transaction
    // creates a race: two concurrent deletes both see count=2 and both proceed → SUPPLIER
    // ends up with 0 contracts. Inside the tx the second writer either sees the first delete
    // (count drops to 1 → guard fires) or rolls back on conflict.
    // Gate the soft-delete on `deletedAt: null` so a re-delete after concurrent winner
    // is a no-op (updateMany.count === 0) instead of resurrecting deletedAt + re-running auto-promote.
    await this.prisma.$transaction(
      async tx => {
        if (cp.type === CounterpartyType.SUPPLIER) {
          const purchaseCount = await tx.counterpartyContract.count({
            where: {
              counterpartyId,
              orgId,
              deletedAt: null,
              contractType: ContractType.PURCHASE,
            },
          });
          if (purchaseCount <= 1) {
            throw new BadRequestException('Постачальник повинен мати хоча б один договір');
          }
        }

        const deleted = await tx.counterpartyContract.updateMany({
          where: { id: contractId, counterpartyId, orgId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        // Concurrent delete winner — nothing to promote, exit cleanly.
        if (deleted.count === 0) return;

        // If deleting a primary contract, auto-promote the next remaining contract of the same type.
        // Otherwise the counterparty would be left without a primary contract for that type —
        // breaking the invariant used by WorkOrder/PurchaseOrder auto-selection.
        if (contract.isPrimary) {
          const next = await tx.counterpartyContract.findFirst({
            where: {
              counterpartyId,
              orgId,
              deletedAt: null,
              contractType: contract.contractType,
              id: { not: contractId },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (next) {
            await tx.counterpartyContract.update({
              where: { id: next.id },
              data: { isPrimary: true },
            });
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private toContractDto(c: {
    id: string;
    orgId: string;
    counterpartyId: string;
    number: string;
    contractType: ContractType;
    startDate: Date;
    endDate: Date | null;
    isPrimary: boolean;
    creditLimit: Prisma.Decimal | null;
    currencyCode: string;
    paymentDeferDays: number | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): ContractResponseDto {
    return {
      id: c.id,
      orgId: c.orgId,
      counterpartyId: c.counterpartyId,
      number: c.number,
      contractType: c.contractType,
      startDate: c.startDate.toISOString().slice(0, 10),
      endDate: c.endDate ? c.endDate.toISOString().slice(0, 10) : null,
      isPrimary: c.isPrimary,
      creditLimit: c.creditLimit ? Number(c.creditLimit) : null,
      currencyCode: c.currencyCode,
      paymentDeferDays: c.paymentDeferDays,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
      deletedAt: c.deletedAt instanceof Date ? c.deletedAt.toISOString() : c.deletedAt,
    };
  }

  private toDto(
    item: {
      id: string;
      orgId: string;
      type: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      edrpou: string | null;
      vatPayer: boolean;
      phone: string | null;
      email: string | null;
      notes: string | null;
      legalForm: LegalForm | null;
      legalAddress: string | null;
      actualAddress: string | null;
      bankAccount: string | null;
      bankName: string | null;
      contactPerson: string | null;
      taxNumber: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date | null;
      settlementAccount: { balance: Prisma.Decimal } | null;
    },
    includeEdrpou = false,
  ): CounterpartyResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      type: item.type as CounterpartyType,
      firstName: item.firstName,
      lastName: item.lastName,
      companyName: item.companyName,
      // edrpou exposed only on detail view — sensitive identifier
      edrpou: includeEdrpou ? item.edrpou : undefined,
      vatPayer: item.vatPayer,
      phone: item.phone,
      email: item.email,
      notes: item.notes,
      legalForm: item.legalForm,
      legalAddress: item.legalAddress,
      actualAddress: item.actualAddress,
      bankAccount: item.bankAccount,
      bankName: item.bankName,
      contactPerson: item.contactPerson,
      taxNumber: item.taxNumber,
      balance: item.settlementAccount ? Number(item.settlementAccount.balance) : 0,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
      deletedAt: item.deletedAt instanceof Date ? item.deletedAt.toISOString() : item.deletedAt,
    };
  }

  private toGarageDto(g: {
    id: string;
    counterpartyId: string;
    name: string;
    address: string | null;
    notes: string | null;
    isDefault: boolean;
    createdAt: Date;
  }): GarageResponseDto {
    return {
      id: g.id,
      counterpartyId: g.counterpartyId,
      name: g.name,
      address: g.address,
      notes: g.notes,
      isDefault: g.isDefault,
      createdAt: g.createdAt instanceof Date ? g.createdAt.toISOString() : g.createdAt,
    };
  }

  // ─── Пов'язані документи ─────────────────────────────────────────────────
  // Документи, у яких фігурує контрагент: рахунки, замовлення постачальнику,
  // оплати постачальнику, повернення постачальнику. Дзеркалить WorkOrder-патерн
  // (orgId + deletedAt:null, take:500, Decimal→Number).

  async getLinkedDocuments(orgId: string, counterpartyId: string) {
    const TAKE = 500;
    // Guard існування (tenant-safe). Не знайдено → порожні секції (без throw).
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp) {
      return { invoices: [], purchaseOrders: [], supplierPayments: [], supplierReturns: [] };
    }

    const [invoices, purchaseOrders, supplierPayments, supplierReturns] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { counterpartyId, orgId, deletedAt: null },
        select: { id: true, number: true, status: true, amount: true, documentDate: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.purchaseOrder.findMany({
        where: { supplierId: counterpartyId, orgId, deletedAt: null },
        select: { id: true, number: true, status: true, totalAmount: true, documentDate: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.supplierPayment.findMany({
        where: { supplierId: counterpartyId, orgId, deletedAt: null },
        select: {
          id: true,
          number: true,
          status: true,
          amount: true,
          method: true,
          documentDate: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.supplierReturn.findMany({
        where: { supplierId: counterpartyId, orgId, deletedAt: null },
        select: { id: true, number: true, status: true, totalAmount: true, documentDate: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
    ]);

    return {
      invoices: invoices.map(i => ({ ...i, amount: Number(i.amount) })),
      purchaseOrders: purchaseOrders.map(p => ({ ...p, totalAmount: Number(p.totalAmount) })),
      supplierPayments: supplierPayments.map(p => ({ ...p, amount: Number(p.amount) })),
      supplierReturns: supplierReturns.map(r => ({ ...r, totalAmount: Number(r.totalAmount) })),
    };
  }

  async getLinkedCounts(
    orgId: string,
    ids: string[],
  ): Promise<
    Record<
      string,
      {
        invoices: number;
        purchaseOrders: number;
        supplierPayments: number;
        supplierReturns: number;
      }
    >
  > {
    if (ids.length === 0) return {};
    const result = initCountsMap(ids, [
      'invoices',
      'purchaseOrders',
      'supplierPayments',
      'supplierReturns',
    ] as const);

    const [inv, po, sp, sr] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['counterpartyId'],
        where: { counterpartyId: { in: ids }, orgId, deletedAt: null },
        _count: { id: true },
      }),
      this.prisma.purchaseOrder.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: ids }, orgId, deletedAt: null },
        _count: { id: true },
      }),
      this.prisma.supplierPayment.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: ids }, orgId, deletedAt: null },
        _count: { id: true },
      }),
      this.prisma.supplierReturn.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: ids }, orgId, deletedAt: null },
        _count: { id: true },
      }),
    ]);

    for (const r of inv)
      if (result[r.counterpartyId]) result[r.counterpartyId].invoices = r._count.id;
    for (const r of po) if (result[r.supplierId]) result[r.supplierId].purchaseOrders = r._count.id;
    for (const r of sp)
      if (result[r.supplierId]) result[r.supplierId].supplierPayments = r._count.id;
    for (const r of sr)
      if (result[r.supplierId]) result[r.supplierId].supplierReturns = r._count.id;

    return result;
  }
}
