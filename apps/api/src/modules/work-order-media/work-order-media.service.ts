import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { WorkOrderMediaResponseDto, WorkOrderMediaListDto } from './work-order-media.dto';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

// Whitelist дозволених розширень — захист від файлів які mime спуфить
// (HTML/JS не може бути виконаний через MinIO, але блокуємо явно для defense in depth).
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'pdf']);

const MAX_FILENAME_LENGTH = 255;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

interface UploadFileInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  size: number;
}

/**
 * Нормалізує filename, прибираючи шляхові компоненти (../, абсолютні шляхи)
 * і обмежуючи довжину. Захист від path traversal та DB overflow.
 */
function sanitizeFilename(raw: string): string {
  // `path.basename` працює тільки з POSIX-стилем, тож додатково чистимо Windows backslash.
  const base = path.basename(raw.replace(/\\/g, '/'));
  const trimmed = base.replace(/[\x00-\x1f]/g, '').trim();
  if (!trimmed) return 'upload';
  return trimmed.slice(0, MAX_FILENAME_LENGTH);
}

@Injectable()
export class WorkOrderMediaService {
  private readonly logger = new Logger(WorkOrderMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async upload(
    orgId: string,
    workOrderId: string,
    uploadedBy: string,
    file: UploadFileInput,
  ): Promise<WorkOrderMediaResponseDto> {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Дозволені формати: JPEG, PNG, HEIC, HEIF, PDF');
    }
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('Файл завеликий (максимум 10 МБ)');
    }

    const filename = sanitizeFilename(file.filename);
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException('Недозволене розширення файлу');
    }

    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const objectName = `org/${orgId}/work-orders/${workOrderId}/${crypto.randomUUID()}.${ext}`;

    await this.files.uploadRaw(file.buffer, objectName, file.mimetype);

    const record = await this.prisma.workOrderMedia.create({
      data: {
        orgId,
        workOrderId,
        fileKey: objectName,
        filename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedBy,
      },
    });

    const signedUrl = await this.files.getSignedUrl(objectName, 3600);
    return this.toDto(record, signedUrl);
  }

  async findAll(orgId: string, workOrderId: string): Promise<WorkOrderMediaListDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    // Bug #88 pattern: total must reflect actual count in DB, not the take-capped length —
    // otherwise UI thinks the user is seeing everything when 51+ items exist.
    const [records, total] = await this.prisma.$transaction([
      this.prisma.workOrderMedia.findMany({
        where: { orgId, workOrderId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.workOrderMedia.count({ where: { orgId, workOrderId } }),
    ]);

    const items = await Promise.all(
      records.map(async r => {
        const signedUrl = await this.files.getSignedUrl(r.fileKey, 3600);
        return this.toDto(r, signedUrl);
      }),
    );

    return { items, total };
  }

  async remove(orgId: string, workOrderId: string, mediaId: string): Promise<void> {
    // Defense-in-depth: scope by orgId+workOrderId на findFirst (для отримання
    // fileKey) + deleteMany з тим самим компаундним where замість delete by id.
    // Запобігає race-window cross-tenant видалення (sto-review pattern 2026-05-30).
    // findFirst тут потрібен бо MinIO cleanup потребує fileKey ДО видалення з DB.
    const record = await this.prisma.workOrderMedia.findFirst({
      where: { id: mediaId, orgId, workOrderId },
      select: { fileKey: true },
    });
    if (!record) throw new NotFoundException('Медіа не знайдено');

    // Bug #116: delete the DB row FIRST. If MinIO deletion fails (network,
    // remote 5xx), we want zero rows pointing at a missing object — the alternative
    // (file gone, DB row stays) is worse because findAll would generate broken
    // signedUrls forever. Failed MinIO cleanup becomes garbage that a batch
    // job can sweep later — we surface it as a warning, not a user error.
    const result = await this.prisma.workOrderMedia.deleteMany({
      where: { id: mediaId, orgId, workOrderId },
    });
    if (result.count === 0) throw new NotFoundException('Медіа не знайдено');
    try {
      await this.files.deleteObject(record.fileKey);
    } catch (e) {
      this.logger.warn(
        `Не вдалось видалити об'єкт MinIO ${record.fileKey} після видалення media-запису: ${String(e)}`,
      );
    }
  }

  private toDto(
    r: {
      id: string;
      workOrderId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      uploadedBy: string;
      createdAt: Date;
    },
    signedUrl: string,
  ): WorkOrderMediaResponseDto {
    // Bug #93: fileKey stays internal — exposed only via the time-limited signedUrl.
    return {
      id: r.id,
      workOrderId: r.workOrderId,
      filename: r.filename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      uploadedBy: r.uploadedBy,
      signedUrl,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
