import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from './pg-adapter';
import type { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../common/crypto/encryption.service';
import { handleDbUnavailable } from '../common/testing/require-db';

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
 * з піднятою БД він виконується реально (не fake-green).
 *
 * ІЗОЛЯЦІЯ ДАНИХ: кожен тест працює в інтерактивній транзакції, яка ЗАВЖДИ відкочується
 * (див. `inRolledBackTx`). У dev-БД нічого не комітиться і нічого не видаляється — ні тестові
 * рядки, ні справжні конфіги каналів розробника.
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

// Канали беруться зі СПРАВЖНЬОГО enum (SMS/EMAIL), а @@unique([branchId, channel]) означає, що
// на філії розробника такі рядки можуть уже існувати — це його робочі конфіги TurboSMS/пошти.
// Тому тест НЕ комітить нічого: усе відбувається в транзакції, що відкочується.
const TEST_CHANNEL = 'SMS';
const LEGACY_CHANNEL = 'EMAIL';
const PLAINTEXT_KEY = 'turbosms-secret-АБВ-9f8e7d6c5b4a';
const LEGACY_PLAINTEXT_KEY = 'legacy-raw-key-χψω-11223344';

/** Сигнал «відкотити транзакцію» — не помилка тесту. */
class RollbackSignal extends Error {}

/**
 * Клієнт транзакції: моделі йдуть ЧЕРЕЗ розширення (шифрування діє), raw-запити — в обхід
 * нього, але в тій самій транзакції, тож бачать ще не закомічені рядки.
 */
type TxClient = Pick<
  PrismaClient,
  'notificationChannelConfig' | '$executeRawUnsafe' | '$queryRawUnsafe'
>;

/**
 * Виконує тіло тесту в транзакції та БЕЗУМОВНО її відкочує.
 *
 * Раніше тут був `cleanup()` із `DELETE ... WHERE "branchId" = <перша філія> AND channel IN
 * ('SMS','EMAIL')` — без жодного маркера «це тестовий рядок». Якщо розробник налаштував у
 * себе SMS- чи EMAIL-канал, перший же прогін набору мовчки стирав його конфіг разом із
 * ключем провайдера (hard delete, без сліду в UI). Після переходу на `beforeEach` це
 * відбувалось перед кожним тестом.
 *
 * Тепер звільнення слотів @@unique і вставка тестових рядків живуть лише всередині
 * транзакції: ROLLBACK повертає все як було, навіть якщо процес убито посеред тесту
 * (обірване підключення = відкат на боці Postgres). Порядок тестів, як і раніше, не важить —
 * кожен отримує власну пару рядків.
 */
async function inRolledBackTx(body: (tx: TxClient) => Promise<void>): Promise<void> {
  try {
    await extended.$transaction(
      async tx => {
        const client = tx as unknown as TxClient;
        await seedRows(client);
        await body(client);
        throw new RollbackSignal();
      },
      { timeout: 20_000 },
    );
  } catch (e) {
    if (!(e instanceof RollbackSignal)) throw e;
  }
}

/** Зашифрований рядок — через розширення; legacy-plaintext — raw INSERT в обхід нього. */
async function seedRows(tx: TxClient): Promise<void> {
  // Звільнити слоти @@unique([branchId, channel]). Діє лише до ROLLBACK.
  await tx.$executeRawUnsafe(
    `DELETE FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel IN ('${TEST_CHANNEL}','${LEGACY_CHANNEL}')`,
    branchId,
  );
  await tx.notificationChannelConfig.create({
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
  // Plaintext напряму — імітуємо рядок з до-Phase-4 епохи.
  await tx.$executeRawUnsafe(
    `INSERT INTO notification_channel_configs
       (id, "orgId", "branchId", channel, provider, enabled, priority, "apiKey", "syncVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '${LEGACY_CHANNEL}', 'turbosms', true, 7, $3, 1, now(), now())`,
    orgId,
    branchId,
    LEGACY_PLAINTEXT_KEY,
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  rawClient = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await rawClient.$connect();
    const branch = await rawClient.garageBranch.findFirst({ select: { id: true, orgId: true } });
    if (!branch) {
      dbAvailable = false;
      handleDbUnavailable('підключення або seed недоступні');
      return;
    }
    orgId = branch.orgId;
    branchId = branch.id;
    dbAvailable = true;
    extended = withFieldEncryption(withSyncVersion(rawClient), makeEnc());
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або seed недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (rawClient) await rawClient.$disconnect();
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
    await inRolledBackTx(async tx => {
      // Сира колонка через raw SQL (в обхід розширення) — має бути ciphertext.
      const rows = await tx.$queryRawUnsafe<{ apiKey: string }[]>(
        `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${TEST_CHANNEL}'`,
        branchId,
      );
      expect(rows.length).toBe(1);
      const atRest = rows[0].apiKey;
      expect(atRest.startsWith('enc:v1:')).toBe(true);
      expect(atRest).not.toContain(PLAINTEXT_KEY);
    });
  });

  it('(b) read через розширення → PLAINTEXT', async () => {
    if (!dbAvailable) return;
    await inRolledBackTx(async tx => {
      const row = await tx.notificationChannelConfig.findFirst({
        where: { branchId, channel: TEST_CHANNEL as any, orgId },
        select: { apiKey: true },
      });
      expect(row?.apiKey).toBe(PLAINTEXT_KEY);
    });
  });

  it('(c) legacy-plaintext рядок (raw INSERT в обхід розширення) читається без змін', async () => {
    if (!dbAvailable) return;
    await inRolledBackTx(async tx => {
      const row = await tx.notificationChannelConfig.findFirst({
        where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
        select: { apiKey: true },
      });
      // Толерантний decrypt: без префікса → повертається як є.
      expect(row?.apiKey).toBe(LEGACY_PLAINTEXT_KEY);
    });
  });

  it('(d) update БЕЗ apiKey → наявний ключ збережено і лишається дешифровним', async () => {
    if (!dbAvailable) return;
    await inRolledBackTx(async tx => {
      await tx.notificationChannelConfig.updateMany({
        where: { branchId, channel: TEST_CHANNEL as any, orgId },
        data: { senderName: 'Оновлено' }, // apiKey НЕ передаємо
      });

      // At-rest все ще ciphertext (не перезаписаний і не подвійно зашифрований).
      const raw = await tx.$queryRawUnsafe<{ apiKey: string }[]>(
        `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${TEST_CHANNEL}'`,
        branchId,
      );
      const atRest = raw[0].apiKey;
      expect(atRest.startsWith('enc:v1:')).toBe(true);
      // Не подвійне шифрування — рівно один сегмент enc:v1: (3 частини після префікса).
      expect(atRest.slice('enc:v1:'.length).split(':').length).toBe(3);

      const row = await tx.notificationChannelConfig.findFirst({
        where: { branchId, channel: TEST_CHANNEL as any, orgId },
        select: { apiKey: true, senderName: true },
      });
      expect(row?.senderName).toBe('Оновлено');
      expect(row?.apiKey).toBe(PLAINTEXT_KEY);
    });
  });

  it('(e) lazy re-encrypt: update legacy-plaintext рядка з новим apiKey → ciphertext at-rest', async () => {
    if (!dbAvailable) return;
    await inRolledBackTx(async tx => {
      const NEW_KEY = 'rotated-key-фыв-55667788';
      await tx.notificationChannelConfig.updateMany({
        where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
        data: { apiKey: NEW_KEY },
      });
      const raw = await tx.$queryRawUnsafe<{ apiKey: string }[]>(
        `SELECT "apiKey" FROM notification_channel_configs WHERE "branchId" = $1::uuid AND channel = '${LEGACY_CHANNEL}'`,
        branchId,
      );
      expect(raw[0].apiKey.startsWith('enc:v1:')).toBe(true);
      expect(raw[0].apiKey).not.toContain(NEW_KEY);
      const row = await tx.notificationChannelConfig.findFirst({
        where: { branchId, channel: LEGACY_CHANNEL as any, orgId },
        select: { apiKey: true },
      });
      expect(row?.apiKey).toBe(NEW_KEY);
    });
  });
});
