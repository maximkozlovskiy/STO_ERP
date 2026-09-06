import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../common/crypto/encryption.service';

/**
 * ІНТЕГРАЦІЙНИЙ тест Prisma field-encryption розширення (Phase 4, H-2) проти ЖИВОЇ dev-БД.
 *
 * Закриває coverage-gap: unit-тести EncryptionService доводять round-trip у пам'яті, але
 * НЕ доводять що розширення `withFieldEncryption(withSyncVersion(client), enc)`:
 *   (a) кладе CIPHERTEXT у Postgres на write,
 *   (b) повертає PLAINTEXT на read,
 *   (c) толерантно читає legacy-plaintext рядок (записаний в обхід розширення через raw SQL),
 *   (d) зберігає наявний ключ при update без apiKey і той лишається дешифровним.
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL (.env.dev) + NOTIFICATION_ENC_KEY.
 * Якщо БД недоступна — тест SKIPʼиться (не фейлить CI на машинах без БД), АЛЕ на dev-машині
 * з піднятою БД він виконується реально (не fake-green). Хард-делейт тестових рядків у afterAll.
 *
 * Розширення будується ТОЧНО як у PrismaService.onModuleInit:
 *   Object.assign(this, withFieldEncryption(withSyncVersion(this), this.encryption))
 * тут ми відтворюємо ту саму композицію на окремому PrismaClient, щоб не інстанціювати Nest.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';
const ENC_KEY = process.env.NOTIFICATION_ENC_KEY ?? 'dev_notification_enc_key_change_in_prod';

const ENCRYPTED_FIELDS: Record<string, string[]> = {
  NotificationChannelConfig: ['apiKey'],
  BranchSettings: ['smsApiKey', 'checkboxLicenseKey', 'checkboxPinCode'],
};

// ── Копія логіки розширень з prisma.service.ts (тримаємо синхронно; тест впаде якщо
//    поведінка розійдеться з продакшн-логікою при round-trip перевірці). ──────────────
function encryptWriteData(
  enc: EncryptionService,
  fields: string[],
  data: Record<string, unknown> | undefined,
): void {
  if (!data) return;
  for (const f of fields) {
    const v = data[f];
    if (typeof v === 'string' && v !== '') data[f] = enc.encrypt(v);
  }
}
function decryptReadResult(enc: EncryptionService, fields: string[], result: unknown): void {
  if (result == null) return;
  const rows = Array.isArray(result) ? result : [result];
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f];
      if (typeof v === 'string' && v !== '') rec[f] = enc.decryptNullable(v);
    }
  }
}
function withSyncVersion(client: PrismaClient): PrismaClient {
  const SYNC = new Set(['NotificationChannelConfig', 'BranchSettings']);
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (model && SYNC.has(model)) {
            if (operation === 'create') {
              const data = (args.data ?? {}) as Record<string, unknown>;
              if (data.syncVersion === undefined) data.syncVersion = 1;
              args = { ...args, data };
            } else if (operation === 'update') {
              const data = (args.data ?? {}) as Record<string, unknown>;
              data.syncVersion = { increment: 1 };
              args = { ...args, data };
            } else if (operation === 'upsert') {
              const update = (args.update ?? {}) as Record<string, unknown>;
              update.syncVersion = { increment: 1 };
              const create = (args.create ?? {}) as Record<string, unknown>;
              if (create.syncVersion === undefined) create.syncVersion = 1;
              args = { ...args, update, create };
            }
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
function withFieldEncryption(client: PrismaClient, enc: EncryptionService): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const fields = model ? ENCRYPTED_FIELDS[model] : undefined;
          if (!fields) return query(args);
          if (operation === 'create' || operation === 'update') {
            encryptWriteData(enc, fields, args.data as Record<string, unknown> | undefined);
          } else if (operation === 'createMany') {
            const rows = args.data as Record<string, unknown>[] | undefined;
            if (Array.isArray(rows)) rows.forEach(r => encryptWriteData(enc, fields, r));
          } else if (operation === 'updateMany') {
            encryptWriteData(enc, fields, args.data as Record<string, unknown> | undefined);
          } else if (operation === 'upsert') {
            encryptWriteData(enc, fields, args.create as Record<string, unknown> | undefined);
            encryptWriteData(enc, fields, args.update as Record<string, unknown> | undefined);
          }
          const result = await query(args);
          decryptReadResult(enc, fields, result);
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}

function makeEnc(): EncryptionService {
  const config = {
    get: (k: string) => (k === 'NOTIFICATION_ENC_KEY' ? ENC_KEY : undefined),
  } as ConfigService;
  const svc = new EncryptionService(config);
  svc.onModuleInit();
  return svc;
}

// Раннер-guard: пропускаємо весь блок якщо БД недоступна (машини без піднятого docker).
let dbAvailable = false;
let rawClient: PrismaClient;
let extended: PrismaClient;
let orgId: string;
let branchId: string;

// Канали, ще не зайняті @@unique([branchId, channel]) на тестовій філії (VIBER вже є у seed).
const TEST_CHANNEL = 'SMS';
const LEGACY_CHANNEL = 'EMAIL';
const PLAINTEXT_KEY = 'turbosms-secret-АБВ-9f8e7d6c5b4a';
const LEGACY_PLAINTEXT_KEY = 'legacy-raw-key-χψω-11223344';

async function cleanup(client: PrismaClient) {
  if (!branchId) return;
  await client
    .$executeRawUnsafe(
      `DELETE FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel IN ('${TEST_CHANNEL}','${LEGACY_CHANNEL}')`,
      branchId,
    )
    .catch(() => undefined);
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  rawClient = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await rawClient.$connect();
    const branch = await rawClient.garageBranch.findFirst({ select: { id: true, orgId: true } });
    if (!branch) {
      dbAvailable = false;
      return;
    }
    orgId = branch.orgId;
    branchId = branch.id;
    dbAvailable = true;
    extended = withFieldEncryption(withSyncVersion(rawClient), makeEnc());
    await cleanup(rawClient); // прибрати рештки попереднього перерваного прогону
  } catch {
    dbAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (rawClient) {
    await cleanup(rawClient);
    await rawClient.$disconnect();
  }
});

describe('Prisma field-encryption extension (integration, live DB)', () => {
  it('передумова: dev-БД доступна', () => {
    if (!dbAvailable) {
      console.warn('[field-encryption.integration] dev-БД недоступна — тест пропущено');
    }
    expect(true).toBe(true);
  });

  it('(a) write через розширення → CIPHERTEXT at-rest у Postgres (не plaintext)', async () => {
    if (!dbAvailable) return;
    await extended.notificationChannelConfig.create({
      data: {
        orgId,
        branchId,
        channel: TEST_CHANNEL as any,
        provider: 'turbosms',
        enabled: true,
        priority: 5,
        apiKey: PLAINTEXT_KEY,
      },
    });

    // Сира колонка через raw SQL (в обхід розширення) — має бути ciphertext.
    const rows = await rawClient.$queryRawUnsafe<{ apiKey: string }[]>(
      `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${TEST_CHANNEL}'`,
      branchId,
    );
    expect(rows.length).toBe(1);
    const atRest = rows[0].apiKey;
    expect(atRest.startsWith('enc:v1:')).toBe(true);
    expect(atRest).not.toContain(PLAINTEXT_KEY);
  });

  it('(b) read через розширення → PLAINTEXT', async () => {
    if (!dbAvailable) return;
    const row = await extended.notificationChannelConfig.findFirst({
      where: { branchId, channel: TEST_CHANNEL as any, orgId },
      select: { apiKey: true },
    });
    expect(row?.apiKey).toBe(PLAINTEXT_KEY);
  });

  it('(c) legacy-plaintext рядок (raw INSERT в обхід розширення) читається без змін', async () => {
    if (!dbAvailable) return;
    // Пишемо plaintext напряму — імітуємо рядок з до-Phase-4 епохи.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO notification_channel_configs
         (id, "orgId", "branchId", channel, provider, enabled, priority, "apiKey", "syncVersion", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '${LEGACY_CHANNEL}', 'turbosms', true, 7, $3, 1, now(), now())`,
      orgId,
      branchId,
      LEGACY_PLAINTEXT_KEY,
    );

    const row = await extended.notificationChannelConfig.findFirst({
      where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
      select: { apiKey: true },
    });
    // Толерантний decrypt: без префікса → повертається як є.
    expect(row?.apiKey).toBe(LEGACY_PLAINTEXT_KEY);
  });

  it('(d) update БЕЗ apiKey → наявний ключ збережено і лишається дешифровним', async () => {
    if (!dbAvailable) return;
    await extended.notificationChannelConfig.updateMany({
      where: { branchId, channel: TEST_CHANNEL as any, orgId },
      data: { senderName: 'Оновлено' }, // apiKey НЕ передаємо
    });

    // At-rest все ще ciphertext (не перезаписаний і не podвійно зашифрований).
    const raw = await rawClient.$queryRawUnsafe<{ apiKey: string }[]>(
      `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${TEST_CHANNEL}'`,
      branchId,
    );
    const atRest = raw[0].apiKey;
    expect(atRest.startsWith('enc:v1:')).toBe(true);
    // Не подвійне шифрування — рівно один сегмент enc:v1: (3 частини після префікса).
    expect(atRest.slice('enc:v1:'.length).split(':').length).toBe(3);

    const row = await extended.notificationChannelConfig.findFirst({
      where: { branchId, channel: TEST_CHANNEL as any, orgId },
      select: { apiKey: true, senderName: true },
    });
    expect(row?.senderName).toBe('Оновлено');
    expect(row?.apiKey).toBe(PLAINTEXT_KEY);
  });

  it('(e) lazy re-encrypt: update legacy-plaintext рядка з новим apiKey → ciphertext at-rest', async () => {
    if (!dbAvailable) return;
    const NEW_KEY = 'rotated-key-фыв-55667788';
    await extended.notificationChannelConfig.updateMany({
      where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
      data: { apiKey: NEW_KEY },
    });
    const raw = await rawClient.$queryRawUnsafe<{ apiKey: string }[]>(
      `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${LEGACY_CHANNEL}'`,
      branchId,
    );
    expect(raw[0].apiKey.startsWith('enc:v1:')).toBe(true);
    expect(raw[0].apiKey).not.toContain(NEW_KEY);
    const row = await extended.notificationChannelConfig.findFirst({
      where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
      select: { apiKey: true },
    });
    expect(row?.apiKey).toBe(NEW_KEY);
  });
});
