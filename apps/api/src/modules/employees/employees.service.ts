import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssignLiftsDto, AssignWorkCategoriesDto, AssignZonesDto,
  CreateEmployeeDto, EmployeeResponseDto, UpdateEmployeeDto,
  rateSchemeSchema, RateScheme,
} from './employees.dto';

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<EmployeeResponseDto[]> {
    const items = await this.prisma.employee.findMany({
      where: { orgId, deletedAt: null },
      include: {
        employeeZones: true,
        employeeLifts: true,
        employeeWorkCategories: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    return items.map(this.toDto);
  }

  async findOne(orgId: string, id: string): Promise<EmployeeResponseDto> {
    const item = await this.prisma.employee.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        employeeZones: true,
        employeeLifts: true,
        employeeWorkCategories: true,
      },
    });
    if (!item) throw new NotFoundException('Співробітника не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateEmployeeDto): Promise<EmployeeResponseDto> {
    this.validateRateScheme(dto.rateScheme);
    const item = await this.prisma.employee.create({
      data: {
        orgId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        rateScheme: dto.rateScheme as object,
        phone: dto.phone,
      },
      include: { employeeZones: true, employeeLifts: true, employeeWorkCategories: true },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateEmployeeDto): Promise<EmployeeResponseDto> {
    await this.findOne(orgId, id);
    if (dto.rateScheme) this.validateRateScheme(dto.rateScheme);
    const item = await this.prisma.employee.update({
      where: { id, orgId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.rateScheme !== undefined && { rateScheme: dto.rateScheme as object }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
      include: { employeeZones: true, employeeLifts: true, employeeWorkCategories: true },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.employee.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Співробітника не знайдено');
    await this.prisma.employee.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  // ─── Assignments ─────────────────────────────────────────

  async assignZones(orgId: string, id: string, dto: AssignZonesDto): Promise<EmployeeResponseDto> {
    await this.findOne(orgId, id);
    // Verify all zones belong to this org
    if (dto.zoneIds.length > 0) {
      const zones = await this.prisma.zone.findMany({
        where: { id: { in: dto.zoneIds }, orgId, deletedAt: null },
      });
      if (zones.length !== dto.zoneIds.length) {
        throw new NotFoundException('Одну або кілька зон не знайдено');
      }
    }
    // Replace assignment atomically using callback form (array form doesn't guarantee atomicity in Prisma 5)
    await this.prisma.$transaction(async (tx) => {
      await tx.employeeZone.deleteMany({ where: { employeeId: id } });
      if (dto.zoneIds.length) {
        await tx.employeeZone.createMany({ data: dto.zoneIds.map(zoneId => ({ employeeId: id, zoneId })) });
      }
    });
    return this.findOne(orgId, id);
  }

  async assignLifts(orgId: string, id: string, dto: AssignLiftsDto): Promise<EmployeeResponseDto> {
    await this.findOne(orgId, id);
    if (dto.liftIds.length > 0) {
      const lifts = await this.prisma.lift.findMany({
        where: { id: { in: dto.liftIds }, orgId, deletedAt: null },
      });
      if (lifts.length !== dto.liftIds.length) {
        throw new NotFoundException('Один або кілька підйомників не знайдено');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.employeeLift.deleteMany({ where: { employeeId: id } });
      if (dto.liftIds.length) {
        await tx.employeeLift.createMany({ data: dto.liftIds.map(liftId => ({ employeeId: id, liftId })) });
      }
    });
    return this.findOne(orgId, id);
  }

  async assignWorkCategories(
    orgId: string,
    id: string,
    dto: AssignWorkCategoriesDto,
  ): Promise<EmployeeResponseDto> {
    await this.findOne(orgId, id);
    if (dto.workCategoryIds.length > 0) {
      const cats = await this.prisma.workCategory.findMany({
        where: { id: { in: dto.workCategoryIds }, orgId, deletedAt: null },
      });
      if (cats.length !== dto.workCategoryIds.length) {
        throw new NotFoundException('Одну або кілька категорій не знайдено');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.employeeWorkCategory.deleteMany({ where: { employeeId: id } });
      if (dto.workCategoryIds.length) {
        await tx.employeeWorkCategory.createMany({ data: dto.workCategoryIds.map(workCategoryId => ({ employeeId: id, workCategoryId })) });
      }
    });
    return this.findOne(orgId, id);
  }

  private validateRateScheme(scheme: unknown): void {
    const result = rateSchemeSchema.safeParse(scheme);
    if (!result.success) {
      throw new BadRequestException(
        `Невірна схема нарахування: ${result.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
  }

  private toDto(item: {
    id: string; orgId: string; userId: string | null; firstName: string; lastName: string;
    role: string; rateScheme: unknown; phone?: string | null; createdAt: Date; updatedAt: Date;
    employeeZones: Array<{ zoneId: string }>;
    employeeLifts: Array<{ liftId: string }>;
    employeeWorkCategories: Array<{ workCategoryId: string }>;
  }): EmployeeResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      userId: item.userId,
      firstName: item.firstName,
      lastName: item.lastName,
      role: item.role as any,
      // rateScheme intentionally omitted — exposed only via OWNER/ADMIN-scoped endpoint
      phone: item.phone,
      zoneIds: item.employeeZones.map((z) => z.zoneId),
      liftIds: item.employeeLifts.map((l) => l.liftId),
      workCategoryIds: item.employeeWorkCategories.map((c) => c.workCategoryId),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async findOneDetail(orgId: string, id: string): Promise<EmployeeResponseDto & { rateScheme: RateScheme }> {
    const item = await this.prisma.employee.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { employeeZones: true, employeeLifts: true, employeeWorkCategories: true },
    });
    if (!item) throw new NotFoundException('Співробітника не знайдено');
    return { ...this.toDto(item), rateScheme: item.rateScheme as RateScheme };
  }
}
