/**
 * OrgPrintInfoService — реквізити й логотип організації для шапки друкованих документів
 * (наряд-замовлення, рахунок, акт виконаних робіт, акт звірки).
 *
 * Аспект: що потрапляє в шапку і що буває, коли з логотипом щось не так. Логотип читається зі
 * сховища за ключем `org/<orgId>/public/...` (не HTTP-запитом на URL), лише PNG/JPEG за
 * першими байтами, не більше 1 МБ, з кешем за `logoUrl`. Будь-яка проблема з логотипом —
 * шапка без нього, реквізити на місці, документ друкується.
 *
 * Сховище, кеш і Prisma — заглушки-об'єкти в конструкторі (без vi.mock модулів).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  OrgPrintInfoService,
  LOGO_MAX_BYTES,
  detectImageMime,
  logoObjectName,
} from './org-print-info.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const LOGO_KEY = `org/${ORG}/public/0b7c2a3e-logo.png`;
const LOGO_URL = `http://localhost:9000/sto-files/${LOGO_KEY}`;

// 1×1 PNG і мінімальний заголовок JPEG — перевіряються саме перші байти.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

type OrgRow = {
  name: string;
  edrpou: string | null;
  ipn: string | null;
  legalAddress: string | null;
  actualAddress: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  primaryBankAccount: {
    orgId: string;
    deletedAt: Date | null;
    ibanUA: string;
    bankName: string | null;
    mfo: string | null;
    edrpou: string | null;
  } | null;
};

function orgRow(over: Partial<OrgRow> = {}): OrgRow {
  return {
    name: 'СТО Альфа',
    edrpou: '12345678',
    ipn: '123456789012',
    legalAddress: 'м. Київ, вул. Юридична, 1',
    actualAddress: 'м. Київ, вул. Фактична, 2',
    phone: '+380501112233',
    email: 'info@alfa.ua',
    logoUrl: null,
    primaryBankAccount: {
      orgId: ORG,
      deletedAt: null,
      ibanUA: 'UA213223130000026007233566001',
      bankName: 'АТ «Банк»',
      mfo: '322313',
      edrpou: null,
    },
    ...over,
  };
}

function setup(row: OrgRow | null, cached: string | null = null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  const getObject = vi.fn().mockResolvedValue(PNG);
  const cache = {
    get: vi.fn().mockResolvedValue(cached),
    set: vi.fn().mockResolvedValue(undefined),
  };
  const service = new OrgPrintInfoService(
    { organisation: { findFirst } } as never,
    { getObject } as never,
    cache as never,
  );
  return { service, findFirst, getObject, cache };
}

describe('OrgPrintInfoService — реквізити для шапки документа', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('читає СВОЮ організацію і віддає назву, ЄДРПОУ, ІПН, телефон, e-mail і основний рахунок', async () => {
    const { service, findFirst } = setup(orgRow());

    const info = await service.get(ORG);

    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { id: ORG } });
    expect(info).toEqual({
      name: 'СТО Альфа',
      edrpou: '12345678',
      ipn: '123456789012',
      address: 'м. Київ, вул. Фактична, 2',
      phone: '+380501112233',
      email: 'info@alfa.ua',
      bank: {
        iban: 'UA213223130000026007233566001',
        bankName: 'АТ «Банк»',
        mfo: '322313',
        edrpou: null,
      },
      logo: null,
    });
  });

  it('адреса — фактична, а коли її немає — юридична', async () => {
    const { service } = setup(orgRow({ actualAddress: null }));
    expect((await service.get(ORG)).address).toBe('м. Київ, вул. Юридична, 1');
  });

  it('основний рахунок видалено → у реквізитах рахунку немає', async () => {
    const row = orgRow();
    row.primaryBankAccount!.deletedAt = new Date('2026-10-01T00:00:00Z');
    const { service } = setup(row);
    expect((await service.get(ORG)).bank).toBeNull();
  });

  it('основний рахунок чужої організації → у реквізитах рахунку немає', async () => {
    const row = orgRow();
    row.primaryBankAccount!.orgId = OTHER_ORG;
    const { service } = setup(row);
    expect((await service.get(ORG)).bank).toBeNull();
  });

  it('основний рахунок не задано → bank = null', async () => {
    const { service } = setup(orgRow({ primaryBankAccount: null }));
    expect((await service.get(ORG)).bank).toBeNull();
  });

  it('організацію не знайдено → лише порожня назва, без падіння', async () => {
    const { service } = setup(null);
    expect(await service.get(ORG)).toEqual({ name: '' });
  });
});

describe('OrgPrintInfoService — логотип у шапці', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PNG зі сховища → data URL, читання за ключем об’єкта з лімітом 1 МБ, результат у кеші', async () => {
    const { service, getObject, cache } = setup(orgRow({ logoUrl: LOGO_URL }));

    const info = await service.get(ORG);

    expect(getObject).toHaveBeenCalledWith(LOGO_KEY, LOGO_MAX_BYTES);
    expect(LOGO_MAX_BYTES).toBe(1024 * 1024);
    expect(info.logo).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set.mock.calls[0]?.[1]).toBe(info.logo);
    expect(warn).not.toHaveBeenCalled();
  });

  it('JPEG теж іде в шапку (тип за байтами)', async () => {
    const { service, getObject } = setup(orgRow({ logoUrl: LOGO_URL }));
    getObject.mockResolvedValue(JPEG);
    expect((await service.get(ORG)).logo).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
  });

  it('логотип є в кеші → сховище не чіпається', async () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    const { service, getObject, cache } = setup(orgRow({ logoUrl: LOGO_URL }), dataUrl);

    expect((await service.get(ORG)).logo).toBe(dataUrl);
    expect(getObject).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('ключ кешу залежить від logoUrl: новий логотип — новий ключ', async () => {
    const a = setup(orgRow({ logoUrl: LOGO_URL }));
    await a.service.get(ORG);
    const b = setup(orgRow({ logoUrl: LOGO_URL.replace('0b7c2a3e', 'ffffffff') }));
    await b.service.get(ORG);

    const keyA = a.cache.get.mock.calls[0]?.[0] as string;
    const keyB = b.cache.get.mock.calls[0]?.[0] as string;
    expect(keyA).toContain(ORG);
    expect(keyA).not.toBe(keyB);
  });

  it('логотипа немає → шапка без логотипа, сховище не чіпається', async () => {
    const { service, getObject } = setup(orgRow({ logoUrl: null }));
    expect((await service.get(ORG)).logo).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
  });

  it('сховище недоступне → шапка без логотипа, реквізити на місці, попередження в лог', async () => {
    const { service, getObject, cache } = setup(orgRow({ logoUrl: LOGO_URL }));
    getObject.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9000'));

    const info = await service.get(ORG);

    expect(info.logo).toBeNull();
    expect(info.bank?.iban).toBe('UA213223130000026007233566001');
    expect(info.ipn).toBe('123456789012');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('файл не PNG і не JPEG (GIF) → шапка без логотипа, попередження', async () => {
    const { service, getObject, cache } = setup(orgRow({ logoUrl: LOGO_URL }));
    getObject.mockResolvedValue(GIF);

    expect((await service.get(ORG)).logo).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('розширення .png, а всередині не PNG → не логотип (перевіряються байти, не назва)', async () => {
    const { service, getObject } = setup(orgRow({ logoUrl: LOGO_URL }));
    getObject.mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect((await service.get(ORG)).logo).toBeNull();
  });

  it('завеликий логотип (сховище обриває читання за лімітом) → шапка без логотипа', async () => {
    const { service, getObject } = setup(orgRow({ logoUrl: LOGO_URL }));
    getObject.mockRejectedValue(new Error(`Object ${LOGO_KEY} exceeds ${LOGO_MAX_BYTES} bytes`));

    expect((await service.get(ORG)).logo).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logoUrl веде на об’єкт ЧУЖОЇ організації → сховище не читається, шапка без логотипа', async () => {
    const foreign = LOGO_URL.replace(ORG, OTHER_ORG);
    const { service, getObject } = setup(orgRow({ logoUrl: foreign }));

    expect((await service.get(ORG)).logo).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('logoObjectName / detectImageMime', () => {
  it('ключ береться з шляху URL від org/<orgId>/public/, з будь-яким префіксом публічного URL', () => {
    expect(logoObjectName(LOGO_URL, ORG)).toBe(LOGO_KEY);
    expect(logoObjectName(`https://sto.example/minio/sto-files/${LOGO_KEY}?v=1`, ORG)).toBe(
      LOGO_KEY,
    );
  });

  it('логотип, завантажений до розділення на public/ (org/<orgId>/<файл>), теж читається', () => {
    expect(logoObjectName(`http://localhost:9000/sto-files/org/${ORG}/7aa6-logo.png`, ORG)).toBe(
      `org/${ORG}/7aa6-logo.png`,
    );
  });

  it.each([
    ['чужа організація (старий шлях)', `http://h/b/org/${OTHER_ORG}/a.png`],
    ['ім’я з «..»', `http://h/b/org/${ORG}/..png`],
    ['чужа організація', `http://h/b/org/${OTHER_ORG}/public/a.png`],
    ['приватна папка наряду', `http://h/b/org/${ORG}/work-orders/wo/a.png`],
    ['вкладений шлях', `http://h/b/org/${ORG}/public/x/a.png`],
    ['вихід угору', `http://h/b/org/${ORG}/public/..%2F..%2Fsecret.png`],
    ['не URL', 'не посилання'],
  ])('%s → null', (_label, url) => {
    expect(logoObjectName(url, ORG)).toBeNull();
  });

  it('тип за першими байтами: PNG, JPEG; інше — null', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(GIF)).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});
