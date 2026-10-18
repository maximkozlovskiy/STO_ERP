import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma, type SupplierConnection } from '@prisma/client';
import {
  translateError,
  type SupplierConnectionCreateValues,
  type SupplierConnectionUpdateValues,
} from '@sto/shared';
import { formatPersonName } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { getLocale } from '../../../common/tenant/tenant-context';
import {
  SupplierAdapterRegistry,
  validateSupplierOptions,
} from '../adapters/supplier-adapter-registry';
import type { SupplierAdapter } from '../adapters/supplier-adapter.interface';
import { SupplierUrlPolicy } from '../http/supplier-url-policy';
import { parseCredentials, parseOptions } from './supplier-connection-context';
import type {
  PaginatedSupplierConnectionsDto,
  SupplierConnectionResponseDto,
  SupplierQueuedResponseDto,
} from './supplier-connections.dto';

const err = (key: string, params?: Record<string, string>) =>
  translateError(key, getLocale(), params);

const CONNECTION_INCLUDE = {
  counterparty: { select: { firstName: true, lastName: true, companyName: true } },
} as const satisfies Prisma.SupplierConnectionInclude;
type ConnectionRow = Prisma.SupplierConnectionGetPayload<{ include: typeof CONNECTION_INCLUDE }>;

/** Partial-unique міграції 20261018120000 (orgId, counterpartyId, provider) WHERE deletedAt IS NULL. */
const UNIQUE_INDEX = 'supplier_connections_org_cp_provider_active_uq';

/**
 * Підключення до API постачальників (BR-SCON-001…004). Рівень організації, кілька активних;
 * креди — лише на запис і шифруються (ENCRYPTED_FIELDS), назовні — `hasCredentials` і перелік
 * заповнених полів. Перевірка підключення — задача черги `supplier-search` (BR-SCON-004).
 */
@Injectable()
export class SupplierConnectionsService {
  private readonly logger = new Logger(SupplierConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly urlPolicy: SupplierUrlPolicy,
    @InjectQueue('supplier-search') private readonly searchQueue: Queue,
  ) {}

  async findAll(orgId: string): Promise<PaginatedSupplierConnectionsDto> {
    const rows = await this.prisma.supplierConnection.findMany({
      where: { orgId, deletedAt: null },
      include: CONNECTION_INCLUDE,
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return { items: rows.map(r => this.toDto(r)), total: rows.length };
  }

  async findOne(orgId: string, id: string): Promise<SupplierConnectionResponseDto> {
    return this.toDto(await this.load(orgId, id));
  }

  async create(
    orgId: string,
    dto: SupplierConnectionCreateValues,
  ): Promise<SupplierConnectionResponseDto> {
    const adapter = this.registry.get(dto.provider);
    await this.assertSupplier(orgId, dto.counterpartyId);
    this.assertApiUrl(dto.apiUrl ?? null);
    const options = await this.checkOptions(orgId, adapter, dto.options);
    const credentials = this.mergeCredentials(adapter, {}, dto.credentials);
    await this.assertNoDuplicate(orgId, dto.counterpartyId, dto.provider, null);
    try {
      const row = await this.prisma.supplierConnection.create({
        data: {
          orgId,
          counterpartyId: dto.counterpartyId,
          provider: dto.provider,
          name: dto.name ?? null,
          enabled: dto.enabled ?? true,
          apiUrl: dto.apiUrl ?? null,
          testMode: dto.testMode ?? false,
          priority: dto.priority ?? 100,
          defaultDeliveryDays: dto.defaultDeliveryDays ?? null,
          credentials: credentials ? JSON.stringify(credentials) : null,
          options: options as Prisma.InputJsonValue,
        },
        include: CONNECTION_INCLUDE,
      });
      return this.toDto(row);
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async update(
    orgId: string,
    id: string,
    dto: SupplierConnectionUpdateValues,
  ): Promise<SupplierConnectionResponseDto> {
    const current = await this.load(orgId, id);
    const adapter = this.registry.get(current.provider);
    if (dto.counterpartyId && dto.counterpartyId !== current.counterpartyId) {
      await this.assertSupplier(orgId, dto.counterpartyId);
      await this.assertNoDuplicate(orgId, dto.counterpartyId, current.provider, id);
    }
    if (dto.apiUrl !== undefined) this.assertApiUrl(dto.apiUrl);
    const options =
      dto.options !== undefined ? await this.checkOptions(orgId, adapter, dto.options) : undefined;
    const before = parseCredentials(current.credentials);
    const urlChanged = dto.apiUrl !== undefined && dto.apiUrl !== current.apiUrl;
    // Нова адреса без повторного введення секретів стирає збережені секрети: інакше «Перевірити»
    // відвезло б їх на хост, який обрав той, хто міняв адресу (BR-SCON-002, 005).
    const secretKeys = adapter.credentialFields.filter(f => f.secret).map(f => f.key);
    const wipeSecrets =
      urlChanged &&
      !!dto.apiUrl &&
      !secretKeys.every(k => (dto.credentials?.[k] ?? '').trim() !== '');
    const kept = wipeSecrets
      ? Object.fromEntries(Object.entries(before).filter(([k]) => !secretKeys.includes(k)))
      : before;
    const touched = dto.credentials !== undefined || wipeSecrets;
    const merged = touched ? this.mergeCredentials(adapter, kept, dto.credentials) : null;
    const credsChanged = touched && JSON.stringify(merged ?? {}) !== JSON.stringify(before);
    try {
      // CAS на updatedAt: два адміністратори, що одночасно зливають креди, не затирають одне одного.
      const res = await this.prisma.supplierConnection.updateMany({
        where: { id, orgId, deletedAt: null, updatedAt: current.updatedAt },
        data: {
          ...(dto.counterpartyId !== undefined ? { counterpartyId: dto.counterpartyId } : {}),
          ...(dto.name !== undefined ? { name: dto.name ?? null } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.apiUrl !== undefined ? { apiUrl: dto.apiUrl } : {}),
          ...(dto.testMode !== undefined ? { testMode: dto.testMode } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.defaultDeliveryDays !== undefined
            ? { defaultDeliveryDays: dto.defaultDeliveryDays }
            : {}),
          ...(options !== undefined ? { options: options as Prisma.InputJsonValue } : {}),
          // Нові креди чи інша адреса — кеш токена й результат перевірки вже не про це підключення.
          ...(credsChanged ? { credentials: merged ? JSON.stringify(merged) : null } : {}),
          ...(credsChanged || urlChanged || dto.testMode !== undefined
            ? { authState: null, verifyStatus: 'NEVER' as const, lastError: null }
            : {}),
        },
      });
      if (res.count !== 1) {
        throw new ConflictException(err('err.supplierConnection.concurrentChange'));
      }
    } catch (e) {
      throw this.mapUnique(e);
    }
    return this.findOne(orgId, id);
  }

  /** BR-SCON-001: видалення — soft delete (і вимкнення: черги його вже не беруть). */
  async remove(orgId: string, id: string): Promise<void> {
    await this.load(orgId, id);
    await this.prisma.supplierConnection.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false, authState: null },
    });
  }

  /** BR-SCON-004: перевірка — задача черги; результат пише обробник. */
  async requestVerify(orgId: string, id: string): Promise<SupplierQueuedResponseDto> {
    const current = await this.load(orgId, id);
    if (!current.credentials || Object.keys(parseCredentials(current.credentials)).length === 0) {
      throw new BadRequestException(err('err.supplierConnection.enterCredentialsFirst'));
    }
    const requestedAt = new Date();
    await this.prisma.supplierConnection.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { verifyStatus: 'PENDING', verifyRequestedAt: requestedAt, lastError: null },
    });
    const queueUnavailable = !(await this.enqueueVerify(orgId, id, requestedAt));
    return { connection: await this.findOne(orgId, id), queueUnavailable };
  }

  /** Постановка перевірки в чергу; false — Redis недоступний (рядок лишається PENDING для sweep). */
  async enqueueVerify(orgId: string, connectionId: string, requestedAt: Date): Promise<boolean> {
    try {
      await this.searchQueue.add(
        'verify',
        { orgId, connectionId },
        {
          attempts: 10,
          backoff: { type: 'exponential', delay: 30_000 },
          jobId: `supplier-verify-${connectionId}-${requestedAt.getTime()}`,
          removeOnComplete: true,
          // sweep перепоставляє той самий jobId — failed-задача з ним мовчки блокувала б повтор.
          removeOnFail: true,
        },
      );
      return true;
    } catch (e) {
      this.logger.warn(
        `Перевірку підключення ${connectionId} не поставлено в чергу: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  // ─── Допоміжне ────────────────────────────────────────────

  private async load(orgId: string, id: string): Promise<ConnectionRow> {
    const row = await this.prisma.supplierConnection.findFirst({
      where: { id, orgId, deletedAt: null },
      include: CONNECTION_INCLUDE,
    });
    if (!row) throw new NotFoundException(err('err.supplierConnection.notFound'));
    return row;
  }

  /** BR-SCON-001 / BR-CP-001: контрагент організації, не видалений, із роллю постачальника. */
  private async assertSupplier(orgId: string, counterpartyId: string): Promise<void> {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { type: true },
    });
    if (!cp || cp.type === 'CLIENT') {
      throw new BadRequestException(err('err.supplierConnection.notSupplier'));
    }
  }

  private async assertNoDuplicate(
    orgId: string,
    counterpartyId: string,
    provider: SupplierConnection['provider'],
    exceptId: string | null,
  ): Promise<void> {
    const dup = await this.prisma.supplierConnection.findFirst({
      where: {
        orgId,
        counterpartyId,
        provider,
        deletedAt: null,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup) throw new ConflictException(err('err.supplierConnection.duplicate'));
  }

  /** BR-SCON-005: `apiUrl` — лише публічна https-адреса (або allowlist фейків поза production). */
  private assertApiUrl(url: string | null): void {
    if (!url) return;
    const reason = this.urlPolicy.checkApiUrl(url);
    if (reason) {
      throw new BadRequestException(
        err('err.supplierConnection.invalidOptions', { details: `apiUrl — ${reason}` }),
      );
    }
  }

  /** BR-SCON-003: опції з опису адаптера; склади мапи — склади організації. */
  private async checkOptions(
    orgId: string,
    adapter: SupplierAdapter,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const { value, errors } = validateSupplierOptions(adapter, raw);
    const ids = Object.keys(value.warehouses ?? {});
    if (ids.length) {
      const found = await this.prisma.warehouse.findMany({
        where: { orgId, id: { in: ids }, deletedAt: null },
        select: { id: true },
        take: ids.length,
      });
      const known = new Set(found.map(w => w.id));
      for (const id of ids) if (!known.has(id)) errors.push(`warehouses: склад ${id} не знайдено`);
    }
    if (errors.length) {
      throw new BadRequestException(
        err('err.supplierConnection.invalidOptions', { details: errors.join('; ') }),
      );
    }
    return value;
  }

  /**
   * BR-SCON-002: креди зливаються з наявними; порожній рядок не стирає збережене. Лише поля з
   * опису адаптера. Повертає null, якщо полів немає.
   */
  private mergeCredentials(
    adapter: SupplierAdapter,
    existing: Record<string, string>,
    incoming: Record<string, string> | undefined,
  ): Record<string, string> | null {
    const allowed = new Set(adapter.credentialFields.map(f => f.key));
    const merged = { ...existing };
    const unknown: string[] = [];
    for (const [k, v] of Object.entries(incoming ?? {})) {
      if (!allowed.has(k)) {
        unknown.push(k);
        continue;
      }
      if (typeof v === 'string' && v.trim() !== '') merged[k] = v.trim();
    }
    if (unknown.length) {
      throw new BadRequestException(
        err('err.supplierConnection.invalidOptions', {
          details: `невідомі поля кредів: ${unknown.join(', ')}`,
        }),
      );
    }
    return Object.keys(merged).length ? merged : null;
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = JSON.stringify(e.meta ?? {});
      if (target.includes(UNIQUE_INDEX) || target.includes('counterpartyId')) {
        return new ConflictException(err('err.supplierConnection.duplicate'));
      }
    }
    return e;
  }

  toDto(r: ConnectionRow): SupplierConnectionResponseDto {
    const creds = parseCredentials(r.credentials);
    let providerName: string = r.provider;
    try {
      providerName = this.registry.get(r.provider).name;
    } catch {
      // невідомий провайдер у БД — показуємо код
    }
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: r.id,
      counterpartyId: r.counterpartyId,
      counterpartyName: formatPersonName(
        r.counterparty.lastName,
        r.counterparty.firstName,
        r.counterparty.companyName,
      ),
      provider: r.provider,
      providerName,
      name: r.name,
      enabled: r.enabled,
      apiUrl: r.apiUrl,
      testMode: r.testMode,
      priority: r.priority,
      defaultDeliveryDays: r.defaultDeliveryDays,
      hasCredentials: Object.keys(creds).length > 0,
      credentialKeys: Object.keys(creds).sort(),
      options: parseOptions(r.options),
      verifyStatus: r.verifyStatus,
      verifyRequestedAt: iso(r.verifyRequestedAt),
      lastVerifiedAt: iso(r.lastVerifiedAt),
      lastError: r.lastError,
      catalogSyncedAt: iso(r.catalogSyncedAt),
      catalogSyncStatus: r.catalogSyncStatus,
      catalogSyncError: r.catalogSyncError,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
