import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../common/crypto/encryption.service';
import { ProviderConfigService } from '../modules/payments/provider-config.service';
import { PrismaService } from './prisma.service';

/**
 * Шифрування секретів at-rest — UNIT-сторож на СПРАВЖНЬОМУ `PrismaService`.
 *
 * Навіщо окремо від `field-encryption.integration.spec.ts`: той ганяє round-trip на живій БД, але
 * будує розширення з ВЛАСНОЇ КОПІЇ `withFieldEncryption` і власного списку `ENCRYPTED_FIELDS`
 * (у копії немає ні `BranchProviderConfig`, ні `CashShift`, ні `monobankToken`). Тому до цього
 * файла можна було прибрати модель із продуктового `ENCRYPTED_FIELDS` або зробити
 * `encryptWriteData` порожнім — і жоден тест не падав: креденшали ПРРО / платіжних шлюзів /
 * доставки пішли б у Postgres відкритим текстом непомітно.
 *
 * Як: беремо продуктовий `PrismaService` і викликаємо його `onModuleInit()` — тобто весь ланцюг
 * `withTenantGuard(withFieldEncryption(withSyncVersion(...)))` рівно як у проді. Підміняємо лише
 * найнижчий шар: `PrismaPg.connect()` повертає фейковий драйвер, який записує SQL і параметри.
 * Параметри запиту — це і є те, що ляже в таблицю: якщо секрету серед них немає у відкритому
 * вигляді, його немає й at-rest. Мережі та БД тест не потребує.
 *
 * `vi.mock('./pg-adapter')` свідомо НЕ вживається: набір іде з `isolate: false`, і мок модуля
 * під спільним графом уже давав плаваючі падіння (див. vitest.config.ts про email.provider).
 * Шпигун на прототипі знімається в afterAll.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '33333333-3333-4333-8333-333333333333';
const ENC_KEY = 'unit-test-encryption-key-not-for-production';
const PREFIX = 'enc:v1:';

// ColumnTypeEnum з @prisma/driver-adapter-utils (пакет не є прямою залежністю api).
const TEXT = 7;
const BOOLEAN = 5;
const COLUMN_TYPES: Record<string, number> = { enabled: BOOLEAN };

interface SentQuery {
  sql: string;
  args: unknown[];
}

/** Усе, що PrismaService відправив у драйвер від останнього `beforeEach`. */
let sent: SentQuery[] = [];
/** Що «БД» повертає на запит: за таблицею з тексту SQL. Порожньо — рядків немає. */
let dbRows: (sql: string) => Record<string, unknown>[] = () => [];

/** Імена колонок із `SELECT … FROM` / `… RETURNING …` — у тому порядку, як їх чекає Prisma. */
function projection(sql: string): string[] {
  const m = /\bRETURNING (.+)$/s.exec(sql) ?? /^SELECT (.+?) FROM /s.exec(sql);
  if (!m) return [];
  return m[1].split(', ').map(piece => {
    const ids = [...piece.matchAll(/"([^"]+)"/g)];
    return ids[ids.length - 1][1];
  });
}

const queryable = {
  provider: 'postgres' as const,
  adapterName: 'fake-recording-driver',
  queryRaw: async (query: SentQuery) => {
    sent.push({ sql: query.sql, args: query.args });
    const columnNames = projection(query.sql);
    return {
      columnNames,
      columnTypes: columnNames.map(c => COLUMN_TYPES[c] ?? TEXT),
      rows: dbRows(query.sql).map(row => columnNames.map(c => row[c] ?? null)),
    };
  },
  executeRaw: async (query: SentQuery) => {
    sent.push({ sql: query.sql, args: query.args });
    return 1;
  },
};
const fakeDriver = {
  ...queryable,
  executeScript: async () => undefined,
  startTransaction: async () => ({
    ...queryable,
    options: { usePhantomQuery: false },
    commit: async () => undefined,
    rollback: async () => undefined,
  }),
  dispose: async () => undefined,
};

function makeEncryption(key: string): EncryptionService {
  const svc = new EncryptionService({
    get: (k: string) => (k === 'NOTIFICATION_ENC_KEY' ? key : undefined),
  } as unknown as ConfigService);
  svc.onModuleInit();
  return svc;
}

const stringArgs = (): string[] =>
  sent.flatMap(q => q.args).filter((a): a is string => typeof a === 'string');

type Delegate = Record<string, (args: unknown) => Promise<unknown>>;

describe('Шифрування секретів at-rest — справжній PrismaService поверх фейкового драйвера', () => {
  let prisma: PrismaService;
  let enc: EncryptionService;
  const delegate = (model: string): Delegate =>
    (prisma as unknown as Record<string, Delegate>)[model[0].toLowerCase() + model.slice(1)];

  /** Секрет не пішов у БД відкритим текстом, а пішов шифротекстом, який розшифровується назад. */
  const expectEncryptedAtRest = (secret: string, times = 1): void => {
    const args = stringArgs();
    expect(
      args.filter(a => a.includes(secret)),
      'секрет у параметрах SQL відкритим текстом',
    ).toEqual([]);
    const ciphertexts = args.filter(a => a.startsWith(PREFIX));
    expect(ciphertexts).toHaveLength(times);
    for (const c of ciphertexts) expect(enc.decrypt(c)).toBe(secret);
  };

  beforeAll(async () => {
    vi.spyOn(PrismaPg.prototype, 'connect').mockResolvedValue(fakeDriver as never);
    enc = makeEncryption(ENC_KEY);
    // PrismaService без DATABASE_URL не конструюється (createPgAdapter кидає). PrismaPg лише
    // запам'ятовує рядок — справжнього з'єднання не буде. Змінну повертаємо ОДРАЗУ: набір іде з
    // `isolate: false`, і залишений тут фейковий URL дістався б integration-спекам того ж воркера,
    // які тоді мовчки пропустили б себе як «БД недоступна».
    const realUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';
    try {
      prisma = new PrismaService(enc);
    } finally {
      if (realUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = realUrl;
    }
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    sent = [];
    dbRows = () => [];
  });

  // ── 1. Кожне секретне поле з ENCRYPTED_FIELDS ────────────────────────────────────────────────
  // Список тут — незалежний від продуктового: прибрати модель чи поле з ENCRYPTED_FIELDS у
  // prisma.service.ts = відповідний рядок червоніє. Нове секретне поле додається В ОБИДВА місця.
  describe('кожне секретне поле пишеться шифротекстом', () => {
    it.each([
      ['BranchProviderConfig', 'credentials', 'ПРРО / платіжний шлюз / служба доставки'],
      ['BranchSettings', 'smsApiKey', 'SMS-провайдер (legacy-колонка)'],
      ['BranchSettings', 'checkboxLicenseKey', 'ПРРО Checkbox (legacy-колонка)'],
      ['BranchSettings', 'checkboxPinCode', 'PIN касира ПРРО (legacy-колонка)'],
      ['BranchSettings', 'monobankToken', 'еквайринг monobank (legacy-колонка)'],
      ['NotificationChannelConfig', 'apiKey', 'канал сповіщень SMS / Viber / Email'],
      ['CashShift', 'checkboxAccessToken', 'токен касира відкритої зміни ПРРО'],
    ])('%s.%s — %s', async (model, field) => {
      const secret = `SECRET-${model}-${field}`;

      await delegate(model).updateMany({ where: { orgId: ORG }, data: { [field]: secret } });

      expect(sent).toHaveLength(1);
      expectEncryptedAtRest(secret);
    });
  });

  // ── 2. Кожна write-операція (на моделі конфігів провайдерів) ─────────────────────────────────
  describe('BranchProviderConfig.credentials — усі write-операції', () => {
    const SECRET = JSON.stringify({ licenseKey: 'LIC-9f3a', pinCode: '4821' });
    const base = { orgId: ORG, branchId: BRANCH, kind: 'FISCAL', provider: 'checkbox' };

    it('create: credentials — шифротекст; несекретні поля (provider) лишаються як є', async () => {
      await prisma.branchProviderConfig.create({
        data: { ...base, kind: 'FISCAL', credentials: SECRET },
        select: { provider: true },
      });

      expectEncryptedAtRest(SECRET);
      expect(stringArgs()).toContain('checkbox');
    });

    it('createMany: кожен рядок шифрується окремо', async () => {
      await prisma.branchProviderConfig.createMany({
        data: [
          { ...base, kind: 'FISCAL', credentials: SECRET },
          { ...base, kind: 'FISCAL', provider: 'vchasno', credentials: SECRET },
        ],
      });

      expectEncryptedAtRest(SECRET, 2);
    });

    it('update: credentials — шифротекст', async () => {
      // update без знайденого рядка Prisma вважає помилкою (P2025) — «БД» повертає оновлений рядок.
      dbRows = () => [{ id: ROW_ID, provider: 'checkbox' }];
      await prisma.branchProviderConfig.update({
        where: { id: ROW_ID, orgId: ORG },
        data: { credentials: SECRET },
        select: { provider: true },
      });

      expectEncryptedAtRest(SECRET);
    });

    it('upsert: шифруються ОБИДВІ гілки — і create, і update', async () => {
      await prisma.branchProviderConfig.upsert({
        where: {
          branchId_kind_provider: { branchId: BRANCH, kind: 'FISCAL', provider: 'checkbox' },
        },
        create: { ...base, kind: 'FISCAL', credentials: SECRET },
        update: { credentials: SECRET },
        select: { provider: true },
      });

      expectEncryptedAtRest(SECRET, 2);
    });

    it('порожній рядок і null не шифруються (немає секрету — немає шифротексту)', async () => {
      await prisma.branchProviderConfig.updateMany({
        where: { orgId: ORG, provider: 'checkbox' },
        data: { credentials: null },
      });
      await prisma.branchProviderConfig.updateMany({
        where: { orgId: ORG, provider: 'vchasno' },
        data: { credentials: '' },
      });

      expect(stringArgs().filter(a => a.startsWith(PREFIX))).toEqual([]);
    });
  });

  // ── 3. Крізь справжнього споживача: ProviderConfigService → PrismaService → драйвер ──────────
  describe('ProviderConfigService: креденшали провайдерів — шифротекст у БД, лише hasCredentials в API', () => {
    const providerRow = (over: Record<string, unknown> = {}) => ({
      id: ROW_ID,
      provider: 'checkbox',
      enabled: false,
      apiUrl: null,
      shiftMode: 'MANUAL',
      credentials: null,
      ...over,
    });
    /** «БД»: філія існує; у branch_provider_configs — те, що передано. */
    const withDb = (configs: Record<string, unknown>[], select: Record<string, unknown>[] = []) => {
      dbRows = sql => {
        if (sql.includes('"garage_branches"')) return [{ id: BRANCH }];
        if (sql.includes('"branch_provider_configs"')) {
          return sql.startsWith('SELECT') ? select : configs;
        }
        return [];
      };
    };

    // guards: BR-PAY-015
    it.each([
      ['FISCAL', 'checkbox', { licenseKey: 'LIC-7c1e44', pinCode: '904417', cashRegisterId: 'r1' }],
      ['FISCAL', 'vchasno', { token: 'VCH-TOKEN-5b20aa' }],
      ['PAYMENT', 'monobank', { token: 'uMONO-X-TOKEN-88d1' }],
      ['PAYMENT', 'liqpay', { publicKey: 'sandbox_i5561', privateKey: 'sandbox_PRIV_k0a9' }],
      ['DELIVERY', 'nova-poshta', { apiKey: 'NP-API-KEY-3e7f19' }],
    ] as const)(
      'upsertConfig %s/%s: жоден секрет не йде в SQL відкритим текстом, відповідь без секретів',
      async (kind, provider, credentials) => {
        withDb([providerRow({ provider })]);
        const svc = new ProviderConfigService(prisma);

        const view = await svc.upsertConfig(ORG, BRANCH, kind, { provider, credentials });

        // at-rest: у параметрах SQL немає жодного значення секрету; є шифротекст цілого JSON.
        const args = stringArgs();
        for (const secret of Object.values(credentials)) {
          expect(
            args.filter(a => a.includes(secret)),
            `секрет ${secret} у параметрах SQL`,
          ).toEqual([]);
        }
        const ciphertexts = args.filter(a => a.startsWith(PREFIX));
        expect(ciphertexts.length).toBeGreaterThanOrEqual(1);
        for (const c of ciphertexts) expect(JSON.parse(enc.decrypt(c))).toEqual(credentials);

        // відповідь API: ні секрету, ні шифротексту — лише прапорець.
        expect(view).toEqual({
          provider,
          enabled: false,
          apiUrl: null,
          shiftMode: 'MANUAL',
          hasCredentials: true,
        });
      },
    );

    // guards: BR-PAY-015
    it('getBranchConfigs: у БД шифротекст → у відповіді ні секрету, ні шифротексту, лише hasCredentials', async () => {
      const stored = enc.encrypt(JSON.stringify({ licenseKey: 'LIC-7c1e44' }));
      withDb(
        [],
        [
          providerRow({ enabled: true, credentials: stored }),
          providerRow({ provider: 'vchasno', credentials: null }),
        ],
      );
      const svc = new ProviderConfigService(prisma);

      const views = await svc.getBranchConfigs(ORG, BRANCH, 'FISCAL');

      expect(views).toEqual([
        {
          provider: 'checkbox',
          enabled: true,
          apiUrl: null,
          shiftMode: 'MANUAL',
          hasCredentials: true,
        },
        {
          provider: 'vchasno',
          enabled: false,
          apiUrl: null,
          shiftMode: 'MANUAL',
          hasCredentials: false,
        },
      ]);
      const body = JSON.stringify(views);
      expect(body).not.toContain('LIC-7c1e44');
      expect(body).not.toContain(PREFIX);
    });

    it('resolveActive: шифротекст із БД доходить до процесора розшифрованим (інакше ПРРО отримав би enc:v1:… замість ключа)', async () => {
      const credentials = { licenseKey: 'LIC-7c1e44', pinCode: '904417' };
      withDb(
        [],
        [providerRow({ enabled: true, credentials: enc.encrypt(JSON.stringify(credentials)) })],
      );
      const svc = new ProviderConfigService(prisma);

      const active = await svc.resolveActive(ORG, BRANCH, 'FISCAL');

      expect(active).toEqual({
        provider: 'checkbox',
        apiUrl: null,
        credentials,
        shiftMode: 'MANUAL',
      });
    });

    it('legacy-рядок із відкритим текстом (записаний до ввімкнення шифрування) читається як є', async () => {
      withDb(
        [],
        [providerRow({ enabled: true, credentials: JSON.stringify({ token: 'OLD-PLAIN' }) })],
      );

      const row = await prisma.branchProviderConfig.findFirst({
        where: { orgId: ORG },
        select: { credentials: true },
      });

      expect(row?.credentials).toBe(JSON.stringify({ token: 'OLD-PLAIN' }));
    });
  });

  // ── 4. Ключ ──────────────────────────────────────────────────────────────────────────────────
  it('дамп БД без ключа марний: шифротекст, записаний цим сервісом, іншим ключем не розшифровується', async () => {
    await prisma.branchProviderConfig.updateMany({
      where: { orgId: ORG },
      data: { credentials: 'TOP-SECRET' },
    });
    const [atRest] = stringArgs().filter(a => a.startsWith(PREFIX));

    expect(enc.decrypt(atRest)).toBe('TOP-SECRET');
    expect(() => makeEncryption('some-other-key').decrypt(atRest)).toThrow();
  });
});
