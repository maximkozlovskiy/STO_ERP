import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WorkOrderMediaService } from './work-order-media.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * WorkOrderMediaService — фото/документи наряду в MinIO. Модуль був БЕЗ тестів.
 *
 * Найделікатніший інваріант тут — ЗАДОКУМЕНТОВАНИЙ порядок у remove(): рядок БД
 * видаляється ПЕРШИМ, лише потім чиститься об'єкт MinIO. Рішення свідоме: «краще 0 рядків
 * на відсутній файл, ніж файл зник, а рядок лишився і генерує биті signedUrl вічно».
 * Збій MinIO НЕ має відкочувати видалення рядка (інакше рядок-привид). Це легко «виправити»
 * назад (спершу MinIO) — тому фіксуємо тестом.
 *
 * Решта:
 *  - tenant+WO scope на findFirst/deleteMany (захист від cross-tenant видалення у race-вікні);
 *  - BR-SEC-UPLOAD (M4): тип визначається за МАГІЧНИМИ БАЙТАМИ вмісту, а не за клієнтським
 *    `mimetype`; у MinIO і DB (отже й у signedUrl) лягає КАНОНІЧНИЙ тип із сигнатури;
 *  - валідація байтів/розширення/розміру ДО звернення до БД і MinIO;
 *  - sanitizeFilename прибирає path-traversal;
 *  - total у findAll = реальний count, а не довжина take-зрізу.
 */

// Реальні сигнатури: вміст визначає тип, а не заявлений клієнтом mimetype.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
describe('WorkOrderMediaService', () => {
  let prisma: { workOrder: PrismaModelMock; workOrderMedia: PrismaModelMock };
  let files: {
    uploadRaw: ReturnType<typeof vi.fn>;
    getSignedUrl: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
  };
  let svc: WorkOrderMediaService;

  const ORG = 'org-1';
  const WO = 'wo-1';
  const MEDIA = 'media-1';
  const FILE_KEY = 'org/org-1/work-orders/wo-1/abc.jpg';

  const validFile = (over: Record<string, unknown> = {}) => ({
    buffer: JPEG_BYTES,
    filename: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
    ...over,
  });

  const mediaRow = (over: Record<string, unknown> = {}) => ({
    id: MEDIA,
    workOrderId: WO,
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    uploadedBy: 'emp-1',
    fileKey: FILE_KEY,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workOrder: modelMock('findFirst'),
      workOrderMedia: modelMock('create', 'findMany', 'count', 'findFirst', 'deleteMany'),
    };
    prisma.workOrder.findFirst.mockResolvedValue({ id: WO });
    prisma.workOrderMedia.create.mockResolvedValue(mediaRow());
    prisma.workOrderMedia.findMany.mockResolvedValue([mediaRow()]);
    prisma.workOrderMedia.count.mockResolvedValue(1);
    prisma.workOrderMedia.findFirst.mockResolvedValue({ fileKey: FILE_KEY });
    prisma.workOrderMedia.deleteMany.mockResolvedValue({ count: 1 });

    files = {
      uploadRaw: vi.fn().mockResolvedValue(undefined),
      getSignedUrl: vi.fn().mockResolvedValue('https://signed/url'),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };

    svc = new WorkOrderMediaService(prisma as never, files as never);
  });

  describe('upload — валідація ДО БД і MinIO', () => {
    it('вміст не зображення/не PDF (хоч клієнт заявив image/png) → 400 (M4)', async () => {
      // Вміст — HTML/текст (підробка .exe/.html → .png), клієнтський mimetype бреше image/png.
      // Тип визначається за БАЙТАМИ → відмова; у MinIO/БД нічого не пишеться.
      const htmlBytes = Buffer.from('<html><script>alert(1)</script></html>', 'utf-8');
      await expect(
        svc.upload(
          ORG,
          WO,
          'emp-1',
          validFile({ buffer: htmlBytes, mimetype: 'image/png', filename: 'evil.png' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(files.uploadRaw).not.toHaveBeenCalled();
      expect(prisma.workOrderMedia.create).not.toHaveBeenCalled();
    });

    it('тип у MinIO і БД — КАНОНІЧНИЙ із сигнатури, а не клієнтський mimetype (M4)', async () => {
      // Клієнт бреше image/png, але байти — JPEG → і сховище, і DB мусять зафіксувати image/jpeg.
      await svc.upload(ORG, WO, 'emp-1', validFile({ mimetype: 'image/png' }));
      expect(files.uploadRaw.mock.calls[0][2]).toBe('image/jpeg');
      expect(prisma.workOrderMedia.create.mock.calls[0][0].data.mimeType).toBe('image/jpeg');
    });

    it('розмір > 10MB → 400', async () => {
      await expect(
        svc.upload(ORG, WO, 'emp-1', validFile({ size: 11 * 1024 * 1024 })),
      ).rejects.toThrow(BadRequestException);
      expect(files.uploadRaw).not.toHaveBeenCalled();
    });

    it('розширення не з whitelist (байти ок — PDF, але .exe) → 400', async () => {
      // Вміст валідний (PDF-сигнатура), а розширення .exe — має впасти на ext-перевірці.
      await expect(
        svc.upload(
          ORG,
          WO,
          'emp-1',
          validFile({ buffer: PDF_BYTES, mimetype: 'application/pdf', filename: 'x.exe' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(files.uploadRaw).not.toHaveBeenCalled();
    });

    it('чужий/видалений наряд → 404, upload у MinIO НЕ відбувається', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      await expect(svc.upload(ORG, WO, 'emp-1', validFile())).rejects.toThrow(NotFoundException);
      expect(files.uploadRaw).not.toHaveBeenCalled();
    });

    it('WO-guard читає наряд у СВОЇЙ org і не видалений', async () => {
      await svc.upload(ORG, WO, 'emp-1', validFile());
      expect(prisma.workOrder.findFirst.mock.calls[0][0].where).toEqual({
        id: WO,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('запис у БД містить orgId із контексту і objectName під префіксом org', async () => {
      await svc.upload(ORG, WO, 'emp-1', validFile());
      const data = prisma.workOrderMedia.create.mock.calls[0][0].data;
      expect(data.orgId).toBe(ORG);
      expect(data.workOrderId).toBe(WO);
      expect(String(data.fileKey)).toMatch(new RegExp(`^org/${ORG}/work-orders/${WO}/`));
      expect(String(data.fileKey).endsWith('.jpg')).toBe(true);
    });

    it('path-traversal у filename знешкоджується (../../etc/passwd → basename)', async () => {
      await svc.upload(
        ORG,
        WO,
        'emp-1',
        validFile({ filename: '../../../etc/passwd.png', mimetype: 'image/png' }),
      );
      const data = prisma.workOrderMedia.create.mock.calls[0][0].data;
      expect(data.filename).toBe('passwd.png');
    });

    it('fileKey НЕ потрапляє у DTO (лише через тимчасовий signedUrl)', async () => {
      const dto = await svc.upload(ORG, WO, 'emp-1', validFile());
      expect(dto).not.toHaveProperty('fileKey');
      expect(dto.signedUrl).toBe('https://signed/url');
    });
  });

  describe('findAll — total ≠ take-зріз', () => {
    it('take=50, але total = реальний count (щоб UI знав про 51+ елементів)', async () => {
      prisma.workOrderMedia.findMany.mockResolvedValue([mediaRow()]);
      prisma.workOrderMedia.count.mockResolvedValue(73);
      const res = await svc.findAll(ORG, WO);
      expect(res.total).toBe(73);
      expect(res.items).toHaveLength(1);
      expect(prisma.workOrderMedia.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('findMany і count скоуплені по orgId+workOrderId', async () => {
      await svc.findAll(ORG, WO);
      expect(prisma.workOrderMedia.findMany.mock.calls[0][0].where).toEqual({
        orgId: ORG,
        workOrderId: WO,
      });
      expect(prisma.workOrderMedia.count.mock.calls[0][0].where).toEqual({
        orgId: ORG,
        workOrderId: WO,
      });
    });

    it('чужий наряд → 404 (не порожній список чужих медіа)', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      await expect(svc.findAll(ORG, WO)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove — порядок видалення (ЗАДОКУМЕНТОВАНИЙ інваріант)', () => {
    it('рядок БД видаляється ПЕРШИМ, лише потім чиститься обʼєкт MinIO', async () => {
      const order: string[] = [];
      prisma.workOrderMedia.deleteMany.mockImplementation(async () => {
        order.push('db');
        return { count: 1 };
      });
      files.deleteObject.mockImplementation(async () => {
        order.push('minio');
      });
      await svc.remove(ORG, WO, MEDIA);
      expect(order).toEqual(['db', 'minio']);
    });

    it('збій MinIO НЕ відкочує видалення рядка і НЕ кидає назовні', async () => {
      files.deleteObject.mockRejectedValue(new Error('MinIO 5xx'));
      await expect(svc.remove(ORG, WO, MEDIA)).resolves.toBeUndefined();
      // рядок усе одно було видалено
      expect(prisma.workOrderMedia.deleteMany).toHaveBeenCalled();
    });

    it('deleteMany скоуплений по id+orgId+workOrderId (захист від cross-tenant)', async () => {
      await svc.remove(ORG, WO, MEDIA);
      expect(prisma.workOrderMedia.deleteMany.mock.calls[0][0].where).toEqual({
        id: MEDIA,
        orgId: ORG,
        workOrderId: WO,
      });
    });

    it('findFirst (для fileKey) теж скоуплений по id+orgId+workOrderId', async () => {
      await svc.remove(ORG, WO, MEDIA);
      expect(prisma.workOrderMedia.findFirst.mock.calls[0][0].where).toEqual({
        id: MEDIA,
        orgId: ORG,
        workOrderId: WO,
      });
    });

    it('запис не знайдено (чужа org) → 404, MinIO не чіпаємо', async () => {
      prisma.workOrderMedia.findFirst.mockResolvedValue(null);
      await expect(svc.remove(ORG, WO, MEDIA)).rejects.toThrow(NotFoundException);
      expect(prisma.workOrderMedia.deleteMany).not.toHaveBeenCalled();
      expect(files.deleteObject).not.toHaveBeenCalled();
    });

    it('deleteMany.count=0 (гонка: вже видалено іншим запитом) → 404, MinIO не чіпаємо', async () => {
      prisma.workOrderMedia.deleteMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, WO, MEDIA)).rejects.toThrow(NotFoundException);
      expect(files.deleteObject).not.toHaveBeenCalled();
    });
  });
});
