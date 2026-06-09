import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContractType, CounterpartyType, LegalForm, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
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

@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentNumberService: DocumentNumberService,
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

    const [items, total] = await this.prisma.$transaction([
      this.prisma.counterparty.findMany({
        where,
        include: { settlementAccount: { select: { balance: true } } },
        orderBy:
          query.sortBy === 'createdAt'
            ? [{ createdAt: query.sortDir === 'asc' ? 'asc' : 'desc' }]
            : query.sortBy === 'balance'
              ? [{ settlementAccount: { balance: query.sortDir === 'asc' ? 'asc' : 'desc' } }]
              : [{ lastName: query.sortDir === 'desc' ? 'desc' : 'asc' }, { companyName: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
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

  async create(orgId: string, dto: CreateCounterpartyDto): Promise<CounterpartyResponseDto> {
    // Bug #348: pre-allocate contract number via DocumentNumberService BEFORE
    // entering the main $transaction. next() uses its own $transaction with
    // SELECT FOR UPDATE — nesting transactions would deadlock or hide the lock.
    // Generate the number only when a contract will actually be created.
    const needsContract = dto.type === 'SUPPLIER' || dto.type === 'BOTH';
    // Bug #360: auto-create PURCHASE contract must use org-level currency (Settings →
    // Org → «Валюта обліку»), not hardcoded 'UAH'. Without this fetch the auto-contract
    // breaks the documented invariant (tooltip: «Використовується за замовчуванням у
    // договорах і звітах»). Fallback to 'UAH' if settings row missing (fresh org).
    // Both lookups are independent + tenant-safe → Promise.all (-1 RTT).
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
        // Auto-create primary PURCHASE contract for suppliers — currencyCode
        // успадковується від org settings (Bug #360).
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
    ); // Bug #132: explicit timeout
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateCounterpartyDto,
  ): Promise<CounterpartyResponseDto> {
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Контрагента не знайдено');
    const item = await this.prisma.counterparty.update({
      where: { id, orgId },
      data: dto,
      include: { settlementAccount: { select: { balance: true } } },
    });
    return this.toDto(item, true);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null) — eliminates race window between guard and write,
    // saves one round-trip per delete.
    const result = await this.prisma.counterparty.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Контрагента не знайдено');
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
    // Якщо клієнт передав isDefault=true → атомарно знімаємо позначку з
    // попереднього default-гаражу і створюємо новий.
    if (dto.isDefault === true) {
      const item = await this.prisma.$transaction(
        async tx => {
          await tx.customerGarage.updateMany({
            where: { orgId, counterpartyId, isDefault: true, deletedAt: null },
            data: { isDefault: false },
          });
          return tx.customerGarage.create({
            data: { orgId, counterpartyId, ...dto },
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      return this.toGarageDto(item);
    }
    const item = await this.prisma.customerGarage.create({
      data: { orgId, counterpartyId, ...dto },
    });
    return this.toGarageDto(item);
  }

  async removeGarage(orgId: string, counterpartyId: string, garageId: string): Promise<void> {
    // Parallel parent (counterparty) guard + child (garage) tenant-scoped fetch (-1 RTT).
    const [cp, garage] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.customerGarage.findFirst({
        where: { id: garageId, counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (!garage) throw new NotFoundException('Гараж не знайдено');
    await this.prisma.customerGarage.update({
      where: { id: garageId, orgId },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Contracts ───────────────────────────────────────────

  private validateContractType(cpType: CounterpartyType, contractType: ContractType): void {
    if (cpType === CounterpartyType.SUPPLIER && contractType === ContractType.SALE)
      throw new BadRequestException('Постачальник може мати лише договір Купівлі');
    if (cpType === CounterpartyType.CLIENT && contractType === ContractType.PURCHASE)
      throw new BadRequestException('Клієнт може мати лише договір Продажу');
  }

  async findContracts(orgId: string, counterpartyId: string): Promise<ContractResponseDto[]> {
    const [cp, items] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      // Bug review: findMany without take is OOM risk. 200 is generous —
      // realistic contract count per counterparty is <10.
      this.prisma.counterpartyContract.findMany({
        where: { counterpartyId, orgId, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: 200,
      }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    return items.map(c => this.toContractDto(c));
  }

  async createContract(
    orgId: string,
    counterpartyId: string,
    dto: CreateContractDto,
  ): Promise<ContractResponseDto> {
    // Bug review: isPrimary is scoped PER contractType — a BOTH-type counterparty
    // can have one primary PURCHASE and one primary SALE simultaneously. Previously
    // the swap unset primary across both types, breaking the auto-PURCHASE invariant
    // when a primary SALE was created.
    // Bug #361: currencyCode сирий string без FK у DB — service ОБОВ'ЯЗКОВО валідує
    // що код існує у Currency таблиці org (як Settings.updateOrganisationSettings).
    // Без guard користувач може зберегти `currencyCode: 'XYZ'` → UX broken у таблиці
    // (`'1 000.00 XYZ'`) + downstream FX-розрахунки впадуть.
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
    // Bug #361: парний guard для PATCH — інакше можна підмінити currencyCode на
    // невалідний через `PATCH .../contracts/<id>` навіть якщо `createContract`
    // блокує `XYZ`. Запускаємо паралельно з cp + contract lookups.
    const [cp, contract, currencyExists] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.counterpartyContract.findFirst({
        where: { id: contractId, counterpartyId, orgId, deletedAt: null },
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

    // Bug review: scope isPrimary swap to SAME contractType only — otherwise
    // setting a SALE contract as primary unsets primary on PURCHASE contracts.
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
    // Bug #352: read full contract to know contractType + isPrimary so we can
    // count only same-type contracts for SUPPLIER guard and auto-promote next
    // primary after deleting the current primary.
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

    // Bug #351 + #352: do guard + soft-delete + auto-promote atomically.
    // Counting OUTSIDE the transaction creates a race: two concurrent deletes
    // both see count=2 and both proceed → SUPPLIER ends up with 0 contracts.
    // Inside Serializable-default tx the second writer either sees the first
    // delete (count drops to 1 → guard fires) or rolls back on conflict.
    // Also gate the soft-delete on `deletedAt: null` so a re-delete after
    // concurrent winner is a no-op (updateMany.count === 0) instead of
    // resurrecting `deletedAt` timestamp and re-running auto-promote.
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

        // Bug #351: if deleting a primary contract, auto-promote the next remaining
        // contract of the same type to primary. Otherwise the counterparty would be
        // left without a primary contract for that type — breaking the invariant
        // used by WorkOrder/PurchaseOrder auto-selection.
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
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      deletedAt: c.deletedAt,
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
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt ?? null,
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
      createdAt: g.createdAt,
    };
  }
}
