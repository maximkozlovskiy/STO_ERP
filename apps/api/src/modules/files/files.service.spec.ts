import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { FilesService } from './files.service';
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
});
