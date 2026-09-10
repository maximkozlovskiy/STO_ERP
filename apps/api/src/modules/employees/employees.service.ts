import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssignBranchesDto,
  AssignLiftsDto,
  AssignWorkCategoriesDto,
  AssignZonesDto,
  CreateEmployeeDto,
  EmployeeResponseDto,
  EmployeesQueryDto,
  UpdateEmployeeDto,
  rateSchemeSchema,
} from './employees.dto';

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    query: EmployeesQueryDto = {},
  ): Promise<{ items: EmployeeResponseDto[]; total: number }> {
    const showDeleted = query.showDeleted === 'true';
    const where: Prisma.EmployeeWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (query.role) where.role = query.role;
    if (query.q) {
      const q = query.q.trim();
      if (q.length > 0) {
        where.OR = [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ];
      }
    }
    const limit = query.limit ?? 20;
    const skip = query.page && query.limit ? (query.page - 1) * query.limit : 0;
    const [items, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        include: {
          employeeZones: { select: { zoneId: true } },
          employeeLifts: { select: { liftId: true } },
          employeeWorkCategories: { select: { workCategoryId: true } },
          employeeBranches: { select: { branchId: true } },
        },
        orderBy:
          query.sortBy === 'createdAt'
            ? [{ createdAt: query.sortDir === 'asc' ? 'asc' : 'desc' }]
            : [{ lastName: query.sortDir === 'desc' ? 'desc' : 'asc' }, { firstName: 'asc' }],
        take: limit,
        skip,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return { items: items.map(item => this.toDto(item)), total };
  }

  async findOne(orgId: string, id: string): Promise<EmployeeResponseDto> {
    const item = await this.prisma.employee.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        employeeZones: { select: { zoneId: true } },
        employeeLifts: { select: { liftId: true } },
        employeeWorkCategories: { select: { workCategoryId: true } },
        employeeBranches: { select: { branchId: true } },
      },
    });
    if (!item) throw new NotFoundException('Співробітника не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateEmployeeDto): Promise<EmployeeResponseDto> {
    this.validateRateScheme(dto.rateScheme);

    if (dto.loginEmail && !dto.password) {
      throw new BadRequestException("Пароль обов'язковий якщо вказано email для входу");
    }

    // Pre-check: active AuthAccount with this email already exists → block.
    // Soft-deleted AuthAccount (deletedAt != null) is handled via resurrection inside TX.
    if (dto.loginEmail) {
      const existing = await this.prisma.authAccount.findUnique({
        where: { orgId_email: { orgId, email: dto.loginEmail } },
        select: { id: true, deletedAt: true, employeeId: true },
      });
      if (existing && existing.deletedAt === null) {
        throw new ConflictException('Цей email вже використовується для входу');
      }
    }

    // Hash bcrypt BEFORE $transaction — bcrypt is ~150ms CPU work; running it inside
    // tx holds Prisma connection idle (matches setup.service.ts pattern).
    const passwordHash =
      dto.loginEmail && dto.password ? await bcrypt.hash(dto.password, 12) : null;

    const item = await this.prisma.$transaction(
      async tx => {
        const employee = await tx.employee.create({
          data: {
            orgId,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: dto.role,
            rateScheme: dto.rateScheme,
            phone: dto.phone,
            email: dto.email,
            // Apply status/dateOfFire if provided — create() used to silently ignore them
            // → frontend always saw ACTIVE regardless of form.status.
            ...(dto.status && { status: dto.status }),
            ...(dto.dateOfHire && { dateOfHire: new Date(dto.dateOfHire) }),
            ...(dto.dateOfFire && { dateOfFire: new Date(dto.dateOfFire) }),
          },
          include: {
            employeeZones: { select: { zoneId: true } },
            employeeLifts: { select: { liftId: true } },
            employeeWorkCategories: { select: { workCategoryId: true } },
            employeeBranches: { select: { branchId: true } },
          },
        });

        if (dto.loginEmail && passwordHash) {
          // Resurrection pattern (§5.2): soft-deleted AuthAccount with the same
          // (orgId,email) blocks create() due to @@unique([orgId,email]). Re-use
          // the row by updating it back to active and re-pointing to the new employee.
          //
          // Race guard inside TX: between pre-check and this findUnique another request could
          // have created an active AuthAccount with the same email. Without explicit check,
          // fall-through to create() → P2002 → generic 500 instead of a clear 409.
          const soft = await tx.authAccount.findUnique({
            where: { orgId_email: { orgId, email: dto.loginEmail } },
            select: { id: true, deletedAt: true },
          });
          if (soft) {
            if (soft.deletedAt === null) {
              throw new ConflictException('Цей email вже використовується для входу');
            }
            // soft-deleted row — resurrection
            await tx.authAccount.update({
              where: { id: soft.id, orgId },
              data: {
                employeeId: employee.id,
                passwordHash,
                deletedAt: null,
              },
            });
          } else {
            await tx.authAccount.create({
              data: {
                orgId,
                employeeId: employee.id,
                email: dto.loginEmail,
                passwordHash,
              },
            });
          }
        }

        return employee;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateEmployeeDto): Promise<EmployeeResponseDto> {
    // sto-optimize: replace findOne (full DTO + 4 join tables) with narrow
    // existence check — лише id потрібен для 404 guard. Update нижче все одно
    // тягне всі relations. -1 over-fetch per call.
    const existing = await this.prisma.employee.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Співробітника не знайдено');
    if (dto.rateScheme) this.validateRateScheme(dto.rateScheme);
    const item = await this.prisma.employee.update({
      where: { id, orgId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.rateScheme !== undefined && { rateScheme: dto.rateScheme }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.dateOfHire !== undefined && {
          dateOfHire: dto.dateOfHire ? new Date(dto.dateOfHire) : null,
        }),
        ...(dto.dateOfFire !== undefined && {
          dateOfFire: dto.dateOfFire ? new Date(dto.dateOfFire) : null,
        }),
      },
      include: {
        employeeZones: { select: { zoneId: true } },
        employeeLifts: { select: { liftId: true } },
        employeeWorkCategories: { select: { workCategoryId: true } },
        employeeBranches: { select: { branchId: true } },
      },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Cascade guard (MD-H1 class): не звільняти співробітника, у якого є рядки
    // нарядів у активному (не термінальному) стані. Без цього soft-delete лишає
    // виконавця, прив'язаного до відкритих нарядів, — робота «зникає» з довідника
    // персоналу, але наряд далі посилається на мертвого механіка (осиротіла ланка).
    // Термінальні статуси (ARCHIVED/CANCELLED) не блокують — узгоджено з MD-H1
    // (counterparty), де історичні документи не заважають видаленню.
    const activeLine = await this.prisma.workOrderLine.findFirst({
      where: {
        orgId,
        employeeId: id,
        deletedAt: null,
        workOrder: { deletedAt: null, status: { notIn: ['ARCHIVED', 'CANCELLED'] } },
      },
      select: { id: true },
    });
    if (activeLine) {
      throw new BadRequestException(
        'Неможливо видалити: співробітник призначений на активні наряди',
      );
    }

    // Cascade soft-delete to AuthAccount — otherwise `findUnique({ orgId_email })` in the next
    // create() finds an active AuthAccount (from the deleted Employee) and throws 409.
    // The resurrection pattern in create() expects a soft-deleted AuthAccount → must mark both atomically.
    const now = new Date();
    const result = await this.prisma.$transaction(
      async tx => {
        const empResult = await tx.employee.updateMany({
          where: { id, orgId, deletedAt: null },
          data: { deletedAt: now },
        });
        if (empResult.count === 0) return { empCount: 0 };
        await tx.authAccount.updateMany({
          where: { employeeId: id, orgId, deletedAt: null },
          data: { deletedAt: now },
        });
        return { empCount: empResult.count };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    if (result.empCount === 0) throw new NotFoundException('Співробітника не знайдено');
  }

  // ─── Assignments ─────────────────────────────────────────

  async assignZones(orgId: string, id: string, dto: AssignZonesDto): Promise<EmployeeResponseDto> {
    // Parallel: tenant guard (employee exists) + cross-tenant FK validation (zones belong to org)
    // are independent reads — collapse into a single RTT. Error messages preserved since both
    // queries complete before any throw.
    const [employee, zones] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.zoneIds.length > 0
        ? this.prisma.zone.findMany({
            where: { id: { in: dto.zoneIds }, orgId, deletedAt: null },
            take: 1000,
            select: { id: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
    ]);
    if (!employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.zoneIds.length > 0 && zones.length !== dto.zoneIds.length) {
      throw new NotFoundException('Одну або кілька зон не знайдено');
    }
    // Replace assignment atomically using callback form (array form doesn't guarantee atomicity in Prisma 5)
    await this.prisma.$transaction(
      async tx => {
        await tx.employeeZone.deleteMany({ where: { employeeId: id } });
        if (dto.zoneIds.length) {
          await tx.employeeZone.createMany({
            data: dto.zoneIds.map(zoneId => ({ employeeId: id, zoneId })),
          });
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.findOne(orgId, id);
  }

  async assignLifts(orgId: string, id: string, dto: AssignLiftsDto): Promise<EmployeeResponseDto> {
    const [employee, lifts] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.liftIds.length > 0
        ? this.prisma.lift.findMany({
            where: { id: { in: dto.liftIds }, orgId, deletedAt: null },
            take: 1000,
            select: { id: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
    ]);
    if (!employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.liftIds.length > 0 && lifts.length !== dto.liftIds.length) {
      throw new NotFoundException('Один або кілька підйомників не знайдено');
    }
    await this.prisma.$transaction(
      async tx => {
        await tx.employeeLift.deleteMany({ where: { employeeId: id } });
        if (dto.liftIds.length) {
          await tx.employeeLift.createMany({
            data: dto.liftIds.map(liftId => ({ employeeId: id, liftId })),
          });
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.findOne(orgId, id);
  }

  async assignWorkCategories(
    orgId: string,
    id: string,
    dto: AssignWorkCategoriesDto,
  ): Promise<EmployeeResponseDto> {
    const [employee, cats] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.workCategoryIds.length > 0
        ? this.prisma.workCategory.findMany({
            where: { id: { in: dto.workCategoryIds }, orgId, deletedAt: null },
            take: 1000,
            select: { id: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
    ]);
    if (!employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.workCategoryIds.length > 0 && cats.length !== dto.workCategoryIds.length) {
      throw new NotFoundException('Одну або кілька категорій не знайдено');
    }
    await this.prisma.$transaction(
      async tx => {
        await tx.employeeWorkCategory.deleteMany({ where: { employeeId: id } });
        if (dto.workCategoryIds.length) {
          await tx.employeeWorkCategory.createMany({
            data: dto.workCategoryIds.map(workCategoryId => ({ employeeId: id, workCategoryId })),
          });
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.findOne(orgId, id);
  }

  async assignBranches(
    orgId: string,
    id: string,
    dto: AssignBranchesDto,
  ): Promise<EmployeeResponseDto> {
    const [employee, branches] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.branchIds.length > 0
        ? this.prisma.garageBranch.findMany({
            where: { id: { in: dto.branchIds }, orgId, deletedAt: null },
            take: 100,
            select: { id: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
    ]);
    if (!employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.branchIds.length > 0 && branches.length !== dto.branchIds.length) {
      throw new NotFoundException('Одну або кілька філій не знайдено');
    }
    await this.prisma.$transaction(
      async tx => {
        await tx.employeeBranch.deleteMany({ where: { employeeId: id } });
        if (dto.branchIds.length) {
          await tx.employeeBranch.createMany({
            data: dto.branchIds.map(branchId => ({ employeeId: id, branchId, orgId })),
          });
        }
        if (dto.allBranches !== undefined) {
          // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
          await tx.employee.updateMany({
            where: { id, orgId, deletedAt: null },
            data: { allBranches: dto.allBranches },
          });
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.findOne(orgId, id);
  }

  private validateRateScheme(scheme: unknown): void {
    const result = rateSchemeSchema.safeParse(scheme);
    if (!result.success) {
      throw new BadRequestException(
        `Невірна схема нарахування: ${result.error.issues.map(i => i.message).join(', ')}`,
      );
    }
  }

  private toDto(item: {
    id: string;
    orgId: string;
    userId: string | null;
    firstName: string;
    lastName: string;
    role: string;
    status: string;
    rateScheme: unknown;
    phone?: string | null;
    email?: string | null;
    dateOfHire?: Date | null;
    dateOfFire?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    allBranches: boolean;
    employeeZones: Array<{ zoneId: string }>;
    employeeLifts: Array<{ liftId: string }>;
    employeeWorkCategories: Array<{ workCategoryId: string }>;
    employeeBranches: Array<{ branchId: string }>;
  }): EmployeeResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      userId: item.userId,
      firstName: item.firstName,
      lastName: item.lastName,
      role: item.role as UserRole,
      status: item.status as import('@prisma/client').EmployeeStatus,
      // rateScheme intentionally omitted — exposed only via OWNER/ADMIN-scoped endpoint
      phone: item.phone,
      email: item.email,
      dateOfHire: item.dateOfHire instanceof Date ? item.dateOfHire.toISOString() : item.dateOfHire,
      dateOfFire: item.dateOfFire instanceof Date ? item.dateOfFire.toISOString() : item.dateOfFire,
      zoneIds: item.employeeZones.map(z => z.zoneId),
      liftIds: item.employeeLifts.map(l => l.liftId),
      workCategoryIds: item.employeeWorkCategories.map(c => c.workCategoryId),
      branchIds: item.employeeBranches.map(b => b.branchId),
      allBranches: item.allBranches,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
      // Surface deletedAt so the UI can render the «видалено» badge when showDeleted=true is on.
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
    };
  }
}
