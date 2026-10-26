import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { FilesService, GET_OBJECT_TIMEOUT_MS } from './files.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * FilesService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Сервіс кладе файли у MinIO і сам нічого не пише в БД — лише ЧИТАЄ `workOrder` як
 * FK-guard. Через це головні інваріанти — не арифметика, а ПОРЯДОК операцій і поведінка
 * при збоях сховища. Minio-клієнт мокаємо повністю.
 *
 *  - **FK-guard (DB) ПЕРЕД storage (putObject)** — для файлу з workOrderId спершу
 *    перевіряємо наряд у своїй org; чужий/видалений → 404 і putObject НЕ викликається
 *    (інакше у сховище осідає orphan-об'єкт під чужим наряд-шляхом);
 *  - **валідація розширення ПЕРЕД storage** — заборонений формат → 400, putObject не
 *    викликається;
 *  - **шлях залежить від наявності workOrderId** — без наряду файл іде у `public/`
 *    (саме цей префікс покриває public-read bucket-policy), з нарядом — у приватну
 *    папку наряду;
 *  - **збій сховища → 500**, назовні не просочується внутрішня помилка minio;
 *  - **клієнт не сконфігурований → 500** на upload, але deleteObject/getSignedUrl —
 *    м'який фолбек (офлайн-незалежність, не валимо систему).
 */
describe('FilesService', () => {
  let svc: FilesService;
  let prisma: { workOrder: PrismaModelMock };
  let client: {
    bucketExists: ReturnType<typeof vi.fn>;
    makeBucket: ReturnType<typeof vi.fn>;
    setBucketPolicy: ReturnType<typeof vi.fn>;
    putObject: ReturnType<typeof vi.fn>;
    presignedGetObject: ReturnType<typeof vi.fn>;
    removeObject: ReturnType<typeof vi.fn>;
    getObject: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const WO = 'wo-1';

  const config = {
    getOrThrow: (k: string) =>
      ({
        MINIO_ENDPOINT: 'localhost',
        MINIO_PORT: '9000',
        MINIO_ACCESS_KEY: 'key',
        MINIO_SECRET_KEY: 'secret',
      })[k] ?? 'x',
    get: (k: string) =>
      ({
        MINIO_USE_SSL: 'false',
        MINIO_PUBLIC_URL: 'http://cdn.local',
        MINIO_BUCKET: 'sto-files',
      })[k],
  };

  const makeFile = (
    over: Partial<{ originalname: string; mimetype: string; size: number }> = {},
  ) => ({
    buffer: Buffer.from('data'),
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 4,
    ...over,
  });

  beforeEach(() => {
    prisma = { workOrder: modelMock('findFirst') };
    prisma.workOrder.findFirst.mockResolvedValue({ id: WO });
    svc = new FilesService(config as never, prisma as never);
    client = {
      bucketExists: vi.fn().mockResolvedValue(true),
      makeBucket: vi.fn(),
      setBucketPolicy: vi.fn(),
      putObject: vi.fn().mockResolvedValue({}),
      presignedGetObject: vi.fn().mockResolvedValue('http://cdn.local/signed'),
      removeObject: vi.fn(),
      getObject: vi.fn(),
    };
    // Конструктор намагається інстанціювати реального minio.Client; у тесті підміняємо.
    (svc as unknown as { client: typeof client }).client = client;
  });

  describe('upload — валідація ПЕРЕД сховищем', () => {
    it('заборонене розширення → 400, putObject НЕ викликається', async () => {
      await expect(svc.upload(ORG, makeFile({ originalname: 'malware.exe' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('файл без розширення → 400', async () => {
      await expect(svc.upload(ORG, makeFile({ originalname: 'noext' }))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('розширення у верхньому регістрі приймається (PNG → png)', async () => {
      await svc.upload(ORG, makeFile({ originalname: 'Logo.PNG' }));
      expect(client.putObject).toHaveBeenCalled();
      const objectName = client.putObject.mock.calls[0][1];
      expect(objectName).toMatch(/\.png$/);
    });
  });

  describe('upload — FK-guard наряду ПЕРЕД storage', () => {
    it('чужий/видалений наряд → 404 і putObject НЕ викликається (без orphan-обєкта)', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      await expect(svc.upload(ORG, makeFile(), 'foreign-wo')).rejects.toThrow(NotFoundException);
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('FK-guard читає наряд у СВОЇЙ org і не видалений', async () => {
      await svc.upload(ORG, makeFile(), WO);
      expect(prisma.workOrder.findFirst.mock.calls[0][0].where).toEqual({
        id: WO,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('без workOrderId FK-guard не виконується', async () => {
      await svc.upload(ORG, makeFile());
      expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('upload — шлях обєкта залежить від workOrderId', () => {
    it('з нарядом → приватна папка наряду (org/<org>/work-orders/<wo>/...)', async () => {
      await svc.upload(ORG, makeFile(), WO);
      const objectName = client.putObject.mock.calls[0][1];
      expect(objectName.startsWith(`org/${ORG}/work-orders/${WO}/`)).toBe(true);
    });

    it('без наряду → public-папка (саме її покриває public-read policy)', async () => {
      await svc.upload(ORG, makeFile());
      const objectName = client.putObject.mock.calls[0][1];
      expect(objectName.startsWith(`org/${ORG}/public/`)).toBe(true);
    });

    it('шлях завжди під своєю org — orgId у префіксі (tenant isolation у сховищі)', async () => {
      const res = await svc.upload(ORG, makeFile());
      expect(client.putObject.mock.calls[0][1].startsWith(`org/${ORG}/`)).toBe(true);
      expect(res.url).toContain(`org/${ORG}/`);
      expect(res.filename).toBe('photo.jpg');
    });
  });

  describe('upload — збої сховища і відсутній клієнт', () => {
    it('putObject кидає → 500 (internal minio-помилка не просочується)', async () => {
      client.putObject.mockRejectedValue(new Error('minio down'));
      await expect(svc.upload(ORG, makeFile())).rejects.toThrow(InternalServerErrorException);
    });

    it('клієнт не сконфігурований → 500, БД навіть не читається', async () => {
      (svc as unknown as { client: null }).client = null;
      await expect(svc.upload(ORG, makeFile(), WO)).rejects.toThrow(InternalServerErrorException);
      expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getSignedUrl / deleteObject / healthCheck — мякий фолбек', () => {
    it('presignedGetObject успішний → повертає підписаний URL', async () => {
      await expect(svc.getSignedUrl('org/x/public/a.png')).resolves.toBe('http://cdn.local/signed');
    });

    it('presignedGetObject кидає → фолбек на прямий public URL (не валимо запит)', async () => {
      client.presignedGetObject.mockRejectedValue(new Error('x'));
      const url = await svc.getSignedUrl('org/x/public/a.png');
      expect(url).toBe('http://cdn.local/sto-files/org/x/public/a.png');
    });

    it('getSignedUrl без клієнта → прямий public URL (офлайн-фолбек)', async () => {
      (svc as unknown as { client: null }).client = null;
      await expect(svc.getSignedUrl('org/x/public/a.png')).resolves.toBe(
        'http://cdn.local/sto-files/org/x/public/a.png',
      );
    });

    it('deleteObject — збій removeObject не кидає (DB-запис все одно видалиться)', async () => {
      client.removeObject.mockRejectedValue(new Error('x'));
      await expect(svc.deleteObject('org/x/public/a.png')).resolves.toBeUndefined();
    });

    it('deleteObject без клієнта → no-op, removeObject не викликається', async () => {
      (svc as unknown as { client: null }).client = null;
      await expect(svc.deleteObject('org/x/public/a.png')).resolves.toBeUndefined();
    });

    it('healthCheck: клієнт відсутній → false; bucketExists кидає → false', async () => {
      await expect(svc.healthCheck()).resolves.toBe(true);
      client.bucketExists.mockRejectedValue(new Error('x'));
      await expect(svc.healthCheck()).resolves.toBe(false);
      (svc as unknown as { client: null }).client = null;
      await expect(svc.healthCheck()).resolves.toBe(false);
    });
  });
  describe('getObject — читання обєкта в памʼять з лімітом (логотип у шапці PDF)', () => {
    it('читає обєкт зі свого bucket і склеює частини потоку', async () => {
      client.getObject.mockResolvedValue(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
      const buf = await svc.getObject('org/x/public/a.png', 10);
      expect(buf.toString()).toBe('abcd');
      expect(client.getObject).toHaveBeenCalledWith('sto-files', 'org/x/public/a.png');
    });

    it('обєкт більший за ліміт → помилка, читання обривається', async () => {
      const stream = Readable.from([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
      client.getObject.mockResolvedValue(stream);
      await expect(svc.getObject('org/x/public/big.png', 10)).rejects.toThrow(/exceeds 10 bytes/);
      expect(stream.destroyed).toBe(true);
    });

    it('обєкт рівно на ліміті читається', async () => {
      client.getObject.mockResolvedValue(Readable.from([Buffer.alloc(10)]));
      await expect(svc.getObject('org/x/public/a.png', 10)).resolves.toHaveLength(10);
    });

    it('клієнт не сконфігурований → помилка (не тихий порожній буфер)', async () => {
      (svc as unknown as { client: null }).client = null;
      await expect(svc.getObject('org/x/public/a.png', 10)).rejects.toThrow(/not configured/);
    });
  });

  // TECH-DEBT §11 п.3: сховище, що зависло (не впало), тримало кожен перший друк PDF без межі.
  describe('getObject — тайм-аут сховища, що зависло', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Потік, що відкрився, але не віддає жодного байта. */
    const hangingStream = () => new Readable({ read() {} });

    it('потік завис → за timeoutMs помилка «timed out», потік закрито', async () => {
      const stream = hangingStream();
      client.getObject.mockResolvedValue(stream);

      const result = svc.getObject('org/x/public/a.png', 10, 1_000);
      const settled = expect(result).rejects.toThrow(/timed out after 1000 ms/);
      await vi.advanceTimersByTimeAsync(1_000);

      await settled;
      expect(stream.destroyed).toBe(true);
    });

    it('типовий тайм-аут — 5 с: до нього читання ще чекає, на 5-й секунді — помилка', async () => {
      expect(GET_OBJECT_TIMEOUT_MS).toBe(5_000);
      client.getObject.mockResolvedValue(hangingStream());
      let outcome: 'pending' | 'rejected' = 'pending';
      const result = svc.getObject('org/x/public/a.png', 10).catch(() => {
        outcome = 'rejected';
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(outcome).toBe('rejected');
    });

    it('сам запит до сховища не відповідає → та сама помилка; потік, що прийшов пізніше, закривається', async () => {
      let open!: (s: Readable) => void;
      client.getObject.mockReturnValue(new Promise<Readable>(r => (open = r)));

      const result = svc.getObject('org/x/public/a.png', 10, 1_000);
      const settled = expect(result).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;

      const late = hangingStream();
      open(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.destroyed).toBe(true);
    });

    it('сховище встигло → дані без помилки, таймер не лишається', async () => {
      client.getObject.mockResolvedValue(Readable.from([Buffer.from('ok')]));
      await expect(svc.getObject('org/x/public/a.png', 10, 1_000)).resolves.toEqual(
        Buffer.from('ok'),
      );
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
