import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { CreateUnitDto, UpdateUnitDto, UnitResponseDto } from './units.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:units:${orgId}`;

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string, showDeleted = false): Promise<UnitResponseDto[]> {
    // Only cache the default (active-only) query — showDeleted is management-only
    if (!showDeleted) {
      const cached = await this.cache.get<UnitResponseDto[]>(cacheKey(orgId));
      if (cached) return cached;
    }

    const items = await this.prisma.unitOfMeasure.findMany({
      where: { orgId, ...(showDeleted ? {} : { deletedAt: null }) },
      // Postgres NULLS LAST by default in ASC → deleted rows (with timestamp) sorted BEFORE active (NULL deletedAt).
      // nulls: 'first' → active rows on top, deleted at bottom (Prisma 5+ syntax).
      orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { shortName: 'asc' }],
      take: 1000,
    });
    const result = items.map(item => this.toDto(item));

    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async restore(orgId: string, id: string): Promise<UnitResponseDto> {
    // sto-optimize: narrow existing guard — restore needs only isSystem + shortName.
    const existing = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { id: true, isSystem: true, shortName: true },
    });
    if (!existing) throw new NotFoundException('Видалену одиницю виміру не знайдено');
    // Defense-in-depth: system units must never be soft-deleted (remove() blocks it).
    // If a system unit appears soft-deleted (direct SQL / seed bug) — reject restore via API.
    if (existing.isSystem)
      throw new BadRequestException('Системну одиницю виміру не можна відновити');
    // Guard against an active duplicate with the same shortName (created after old was soft-deleted)
    // — without this, restore() triggers P2002 unique violation → 500 instead of 409.
    const activeDuplicate = await this.prisma.unitOfMeasure.findFirst({
      where: { orgId, shortName: existing.shortName, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(
        'Активна одиниця з такою скороченою назвою вже існує — відновлення неможливе',
      );
    const item = await this.prisma.unitOfMeasure.update({
      where: { id, orgId },
      data: { deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async findOne(orgId: string, id: string): Promise<UnitResponseDto> {
    const item = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Одиниця виміру не знайдена');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateUnitDto): Promise<UnitResponseDto> {
    // sto-optimize: only id + deletedAt consumed (restore-vs-conflict branch).
    const anyExisting = await this.prisma.unitOfMeasure.findFirst({
      where: { orgId, shortName: dto.shortName },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
      const restored = await this.prisma.unitOfMeasure.update({
        where: { id: anyExisting.id },
        data: { ...dto, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(restored);
    }
    const item = await this.prisma.unitOfMeasure.create({ data: { ...dto, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateUnitDto): Promise<UnitResponseDto> {
    // sto-optimize (2026-05-31 pattern): speculative duplicate-check у Promise.all з
    // tenant-guard. Duplicate-check читає за `dto.shortName` (не за existing) → не
    // залежить від результату першого запиту. У ~95% випадків (shortName не змінився
    // або не вказаний) duplicate query повертає null швидко (індекс @@unique hit). У
    // 5% коли shortName реально змінився — економимо 1 RTT. Post-filter перевіряє
    // existing.shortName !== dto.shortName ПОСТ-факто без додаткового запиту.
    const [existing, duplicate] = await Promise.all([
      // Narrow projection — full DTO load марний (update сам повертає item);
      // потрібен лише `shortName` для post-filter порівняння з dto.shortName.
      this.prisma.unitOfMeasure.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true, shortName: true },
      }),
      dto.shortName
        ? this.prisma.unitOfMeasure.findFirst({
            // Check both active and soft-deleted duplicates: @@unique([orgId, shortName]) has no
            // partial WHERE deletedAt IS NULL → conflict with a soft-deleted row raises P2002 → 500 instead of 409.
            where: { orgId, shortName: dto.shortName, NOT: { id } },
            select: { id: true, deletedAt: true },
          })
        : Promise.resolve(null),
    ]);
    if (!existing) throw new NotFoundException('Одиниця виміру не знайдена');
    if (dto.shortName && existing.shortName !== dto.shortName && duplicate) {
      if (duplicate.deletedAt) {
        throw new ConflictException(
          'Одиниця з такою скороченою назвою існує у архіві. Спочатку відновіть її або оберіть інше скорочення.',
        );
      }
      throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
    }
    const item = await this.prisma.unitOfMeasure.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize (2026-05-31 pattern): `findOne + update` 2-RTT → атомарний updateMany
    // з повним compound where (id+orgId+deletedAt:null+isSystem:false). isSystem guard
    // інкапсулюється у WHERE, тому soft-delete системної одиниці просто не зачіпає рядок.
    // count=0 інтерпретуємо: спочатку перевіряємо `isSystem` через окремий cheap read
    // лише якщо updateMany нічого не зачепив (для збереження конкретного повідомлення UA).
    const result = await this.prisma.unitOfMeasure.updateMany({
      where: { id, orgId, deletedAt: null, isSystem: false },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      const existing = await this.prisma.unitOfMeasure.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { isSystem: true },
      });
      if (!existing) throw new NotFoundException('Одиниця виміру не знайдена');
      if (existing.isSystem)
        throw new BadRequestException('Системну одиницю виміру не можна видалити');
      // Race: hard-deleted between updateMany and findFirst
      throw new NotFoundException('Одиниця виміру не знайдена');
    }
    await this.cache.del(cacheKey(orgId));
  }

  toDto(item: {
    id: string;
    orgId: string;
    name: string;
    shortName: string;
    isSystem: boolean;
    coefficient: number;
    width: number | null;
    height: number | null;
    depth: number | null;
    volume: number | null;
    weight: number | null;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): UnitResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      shortName: item.shortName,
      isSystem: item.isSystem,
      coefficient: item.coefficient,
      width: item.width,
      height: item.height,
      depth: item.depth,
      volume: item.volume,
      weight: item.weight,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
