import { Controller, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import * as path from 'path';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { FilesService } from './files.service';

const MAX_FILENAME_LENGTH = 255;

// Захист від path traversal у оригінальній назві файлу: нормалізуємо POSIX/Windows
// розділювачі, прибираємо керівні символи й обмежуємо довжину перед збереженням.
// Узгоджено з work-order-media.service.ts sanitizeFilename.
function sanitizeFilename(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/'));
  const trimmed = base.replace(/[\x00-\x1f]/g, '').trim();
  if (!trimmed) return 'upload';
  return trimmed.slice(0, MAX_FILENAME_LENGTH);
}

@ApiTags('Files')
@Controller('files')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class FilesController {
  constructor(private readonly service: FilesService) {}

  @Post('upload')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: 'Upload file (photo) to MinIO' })
  @ApiConsumes('multipart/form-data')
  async upload(@OrgContext() orgId: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Очікується multipart/form-data');
    }

    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let filename = 'photo.jpg';
    let mimetype = 'image/jpeg';
    let workOrderId: string | undefined;

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename;
        mimetype = part.mimetype;
      } else if (part.fieldname === 'workOrderId' && typeof part.value === 'string') {
        workOrderId = part.value;
      }
    }

    if (!fileBuffer) throw new BadRequestException('Файл не отримано');
    if (!mimetype.startsWith('image/'))
      throw new BadRequestException('Дозволені тільки зображення');
    if (fileBuffer.length > 10 * 1024 * 1024)
      throw new BadRequestException('Файл завеликий (максимум 10 МБ)');

    // Захист від path traversal у назві файлу + DB overflow guard (узгоджено
    // з work-order-media.service.ts sanitizeFilename).
    const safeName = sanitizeFilename(filename);

    return this.service.upload(
      orgId,
      { buffer: fileBuffer, originalname: safeName, mimetype, size: fileBuffer.length },
      workOrderId,
    );
  }
}
