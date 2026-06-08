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
    const [items, total] = await this.prisma.$transaction([
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

    if (dto.loginEmail) {
      const existing = await this.prisma.authAccount.findUnique({
        where: { orgId_email: { orgId, email: dto.loginEmail } },
      });
      if (existing) throw new ConflictException('Цей email вже використовується для входу');
    }

    const item = await this.prisma.$transaction(
      async tx => {
        const employee = await tx.employee.create({
          data: {
            orgId,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: dto.role,
            rateScheme: dto.rateScheme as object,
            phone: dto.phone,
            email: dto.email,
            ...(dto.dateOfHire && { dateOfHire: new Date(dto.dateOfHire) }),
          },
          include: {
            employeeZones: { select: { zoneId: true } },
            employeeLifts: { select: { liftId: true } },
            employeeWorkCategories: { select: { workCategoryId: true } },
            employeeBranches: { select: { branchId: true } },
          },
        });

        if (dto.loginEmail && dto.password) {
          const passwordHash = await bcrypt.hash(dto.password, 12);
          await tx.authAccount.create({
            data: {
              orgId,
              employeeId: employee.id,
              email: dto.loginEmail,
              passwordHash,
            },
          });
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
        ...(dto.rateScheme !== undefined && { rateScheme: dto.rateScheme as object }),
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
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null) — eliminates race window, saves one round-trip.
    const result = await this.prisma.employee.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Співробітника не знайдено');
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
    ); // Bug #132: explicit timeout
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
    ); // Bug #132: explicit timeout
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
    ); // Bug #132: explicit timeout
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
    ); // Bug #132: explicit timeout
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
      dateOfHire: item.dateOfHire,
      dateOfFire: item.dateOfFire,
      zoneIds: item.employeeZones.map(z => z.zoneId),
      liftIds: item.employeeLifts.map(l => l.liftId),
      workCategoryIds: item.employeeWorkCategories.map(c => c.workCategoryId),
      branchIds: item.employeeBranches.map(b => b.branchId),
      allBranches: item.allBranches,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      // Surface deletedAt so the UI can render the «видалено» badge when showDeleted=true is on.
      deletedAt: item.deletedAt ?? null,
    };
  }
}
