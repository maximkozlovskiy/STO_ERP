import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable } from '../../cash/cash.spec-fixture';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type { SupplierAdapter } from '../adapters/supplier-adapter.interface';
import { SupplierUrlPolicy } from '../http/supplier-url-policy';
import { ORG, OUR_WH, SUPPLIER_CP } from '../supplier-api.spec-fixture';
import { SupplierConnectionsService } from './supplier-connections.service';

/**
 * Підключення до API постачальників (BR-SCON-001…005): справжній сервіс над таблицями в пам'яті
 * (`where` виконується), справжні реєстр і політика адрес; черга — заглушка.
 */
const CLIENT_CP = '51111111-1111-4111-8111-999999999999';
const OTHER_ORG_CP = '51111111-1111-4111-8111-888888888888';
const OTHER_ORG_WH = '21111111-1111-4111-8111-999999999999';

const adapter = {
  provider: 'AVD_TRADE',
  name: 'AVD Trade',
  capabilities: { search: 'mirror' },
  credentialFields: [
    { key: 'apiKey', label: 'Ключ', secret: true, required: true, type: 'string' },
  ],
  optionFields: [],
  warehouseFields: [
    { key: 'locationUuid', label: 'Торгова точка', secret: false, required: true, type: 'string' },
  ],
} as unknown as SupplierAdapter;
const utrLike = {
  ...adapter,
  provider: 'UTR',
  name: 'UTR',
  credentialFields: [
    { key: 'email', label: 'Логін', secret: false, required: true, type: 'string' },
    { key: 'password', label: 'Пароль', secret: true, required: true, type: 'string' },
  ],
  warehouseFields: [],
} as unknown as SupplierAdapter;

function setup(queueAdd = vi.fn(() => Promise.resolve({}))) {
  const counterparty = memoryTable([
    {
      id: SUPPLIER_CP,
      orgId: ORG,
      type: 'SUPPLIER',
      companyName: 'ТОВ AVD',
      firstName: null,
      lastName: null,
      deletedAt: null,
    },
    {
      id: CLIENT_CP,
      orgId: ORG,
      type: 'CLIENT',
      firstName: 'Іван',
      lastName: 'Клієнт',
      companyName: null,
      deletedAt: null,
    },
    {
      id: OTHER_ORG_CP,
      orgId: 'other-org',
      type: 'SUPPLIER',
      companyName: 'Чужий',
      deletedAt: null,
    },
  ]);
  const warehouse = memoryTable([
    { id: OUR_WH, orgId: ORG, deletedAt: null },
    { id: OTHER_ORG_WH, orgId: 'other-org', deletedAt: null },
  ]);
  const supplierConnection = memoryTable(
    [],
    () => ({
      createdAt: new Date('2026-10-18T08:00:00Z'),
      updatedAt: new Date('2026-10-18T08:00:00Z'),
      deletedAt: null,
      authState: null,
      verifyStatus: 'NEVER',
      verifyRequestedAt: null,
      lastVerifiedAt: null,
      lastError: null,
      catalogSyncedAt: null,
      catalogSyncStatus: null,
      catalogSyncError: null,
    }),
    { counterparty: r => counterparty.rows.find(c => c.id === r.counterpartyId) ?? null },
  );
  const prisma = { counterparty, warehouse, supplierConnection } as unknown as PrismaService;
  const service = new SupplierConnectionsService(
    prisma,
    new SupplierAdapterRegistry([adapter, utrLike]),
    SupplierUrlPolicy.fromEnv({ NODE_ENV: 'test' }),
    { add: queueAdd } as unknown as Queue,
  );
  return { service, supplierConnection, queueAdd };
}

const base = { counterpartyId: SUPPLIER_CP, provider: 'AVD_TRADE' as const };

describe('SupplierConnectionsService — підключення (BR-SCON-001…005)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  // guards: BR-SCON-001
  it('контрагент-клієнт чи чужої організації → 400 notSupplier', async () => {
    await expect(s.service.create(ORG, { ...base, counterpartyId: CLIENT_CP })).rejects.toThrow(
      BadRequestException,
    );
    await expect(s.service.create(ORG, { ...base, counterpartyId: OTHER_ORG_CP })).rejects.toThrow(
      'Контрагент не є постачальником',
    );
  });

  // guards: BR-SCON-001
  it('одне підключення на (контрагент, провайдер) серед невидалених: дубль → 409; після видалення — можна', async () => {
    const first = await s.service.create(ORG, base);
    await expect(s.service.create(ORG, base)).rejects.toThrow(ConflictException);
    await expect(s.service.create(ORG, { ...base, provider: 'UTR' })).resolves.toMatchObject({
      provider: 'UTR',
    });
    await s.service.remove(ORG, first.id);
    expect(s.supplierConnection.rows[0]).toMatchObject({ enabled: false });
    expect(s.supplierConnection.rows[0].deletedAt).toBeInstanceOf(Date);
    await expect(s.service.findOne(ORG, first.id)).rejects.toThrow(NotFoundException);
    await expect(s.service.create(ORG, base)).resolves.toBeDefined();
  });

  // guards: BR-SCON-002
  it('креди не повертаються: лише hasCredentials і перелік полів; authState теж ні', async () => {
    const dto = await s.service.create(ORG, { ...base, credentials: { apiKey: 'SECRET-1' } });
    expect(JSON.stringify(dto)).not.toContain('SECRET-1');
    expect(dto).toMatchObject({ hasCredentials: true, credentialKeys: ['apiKey'] });
    expect(dto).not.toHaveProperty('credentials');
    expect(dto).not.toHaveProperty('authState');
  });

  // guards: BR-SCON-002
  it('оновлення зливає креди; порожнє значення не стирає; зміна кредів скидає кеш токена й перевірку', async () => {
    const c = await s.service.create(ORG, {
      ...base,
      provider: 'UTR',
      credentials: { email: 'a@b.ua', password: 'p1' },
    });
    Object.assign(s.supplierConnection.rows[0], {
      authState: '{"accessToken":"t"}',
      verifyStatus: 'OK',
    });
    await s.service.update(ORG, c.id, { credentials: { email: '', password: 'p2' } });
    const row = s.supplierConnection.rows[0];
    expect(JSON.parse(row.credentials as string)).toEqual({ email: 'a@b.ua', password: 'p2' });
    expect(row).toMatchObject({ authState: null, verifyStatus: 'NEVER' });
    // Незмінені креди — кеш токена лишається.
    row.authState = '{"accessToken":"t2"}';
    await s.service.update(ORG, c.id, { credentials: { password: 'p2' }, priority: 5 });
    expect(row.authState).toBe('{"accessToken":"t2"}');
  });

  // guards: BR-SCON-002
  it('невідоме поле кредів → 400 invalidOptions', async () => {
    await expect(s.service.create(ORG, { ...base, credentials: { token: 'x' } })).rejects.toThrow(
      /невідомі поля кредів: token/,
    );
  });

  // guards: BR-SCON-003
  it('опції — лише з опису адаптера; склад мапи — склад організації', async () => {
    await expect(
      s.service.create(ORG, {
        ...base,
        options: { warehouses: { [OTHER_ORG_WH]: { locationUuid: 'l' } } },
      }),
    ).rejects.toThrow(/не знайдено/);
    await expect(s.service.create(ORG, { ...base, options: { foo: 1 } })).rejects.toThrow(
      /невідоме поле «foo»/,
    );
    const ok = await s.service.create(ORG, {
      ...base,
      options: { warehouses: { [OUR_WH]: { locationUuid: 'loc-1' } } },
    });
    expect(ok.options).toEqual({ warehouses: { [OUR_WH]: { locationUuid: 'loc-1' } } });
  });

  // guards: BR-SCON-005
  it('apiUrl на localhost / приватну мережу → 400 (без allowlist фейків)', async () => {
    await expect(
      s.service.create(ORG, { ...base, apiUrl: 'http://127.0.0.1:4100/avd' }),
    ).rejects.toThrow(/apiUrl/);
    await expect(
      s.service.create(ORG, { ...base, apiUrl: 'https://dev-api.avdtrade.com.ua/api/v1' }),
    ).resolves.toBeDefined();
    // Поза allowlist фейків — лише https: секрети йдуть у заголовках і тілі.
    await expect(
      s.service.create(ORG, { ...base, provider: 'UTR', apiUrl: 'http://api.example.com/v1' }),
    ).rejects.toThrow(/https/);
  });

  // guards: BR-SCON-002
  it('нова apiUrl без повторного введення секретів стирає збережені секрети й кеш токена', async () => {
    const c = await s.service.create(ORG, {
      ...base,
      provider: 'UTR',
      credentials: { email: 'a@b.ua', password: 'p1' },
    });
    const row = s.supplierConnection.rows[0];
    row.authState = '{"accessToken":"t"}';
    await s.service.update(ORG, c.id, { apiUrl: 'https://collector.example.com/api' });
    // Секрет не поїде на хост, обраний тим, хто міняв адресу; несекретний логін лишається.
    expect(JSON.parse(row.credentials as string)).toEqual({ email: 'a@b.ua' });
    expect(row.authState).toBeNull();
    // Адреса разом із новим секретом — зберігається новий.
    await s.service.update(ORG, c.id, {
      apiUrl: 'https://other.example.com/api',
      credentials: { password: 'p2' },
    });
    expect(JSON.parse(row.credentials as string)).toEqual({ email: 'a@b.ua', password: 'p2' });
    // Інші зміни без адреси секретів не чіпають.
    await s.service.update(ORG, c.id, { priority: 7 });
    expect(JSON.parse(row.credentials as string)).toEqual({ email: 'a@b.ua', password: 'p2' });
  });

  // guards: BR-SCON-004
  it('перевірка без кредів → 400; з кредами — PENDING і задача verify з attempts 10, експоненційним backoff', async () => {
    const c = await s.service.create(ORG, base);
    await expect(s.service.requestVerify(ORG, c.id)).rejects.toThrow(
      'Спершу введіть дані доступу до API',
    );
    await s.service.update(ORG, c.id, { credentials: { apiKey: 'k' } });
    const res = await s.service.requestVerify(ORG, c.id);
    expect(res).toMatchObject({ queueUnavailable: false, connection: { verifyStatus: 'PENDING' } });
    expect(s.queueAdd).toHaveBeenCalledWith(
      'verify',
      { orgId: ORG, connectionId: c.id },
      // removeOnFail: true — sweep перепоставляє той самий jobId, failed-задача його б блокувала.
      expect.objectContaining({
        attempts: 10,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnFail: true,
      }),
    );
    // У job.data — лише id, без кредів.
    expect(JSON.stringify(s.queueAdd.mock.calls[0])).not.toContain('"k"');
  });

  // guards: BR-SCON-006
  it('Redis недоступний → рядок лишається PENDING, відповідь позначає queueUnavailable (підхопить sweep)', async () => {
    s = setup(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const c = await s.service.create(ORG, { ...base, credentials: { apiKey: 'k' } });
    const res = await s.service.requestVerify(ORG, c.id);
    expect(res).toMatchObject({ queueUnavailable: true, connection: { verifyStatus: 'PENDING' } });
  });

  it('чуже підключення — 404', async () => {
    const c = await s.service.create(ORG, base);
    await expect(s.service.findOne('other-org', c.id)).rejects.toThrow(NotFoundException);
    await expect(s.service.update('other-org', c.id, { priority: 1 })).rejects.toThrow(
      NotFoundException,
    );
  });
});
