import { Injectable, InternalServerErrorException, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'pdf']);

interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class FilesService implements OnModuleInit {
  private readonly publicUrl: string;
  private readonly bucket = 'sto-erp';
  private client: {
    bucketExists(name: string): Promise<boolean>;
    makeBucket(name: string, region: string): Promise<void>;
    putObject(bucket: string, object: string, stream: Buffer, size: number, meta: Record<string, string>): Promise<unknown>;
  } | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const endpoint = config.getOrThrow<string>('MINIO_ENDPOINT');
    const port = parseInt(config.getOrThrow<string>('MINIO_PORT'), 10);
    const useSSL = config.get<string>('MINIO_USE_SSL') === 'true';
    const protocol = useSSL ? 'https' : 'http';
    this.publicUrl = config.get<string>('MINIO_PUBLIC_URL') ?? `${protocol}://${endpoint}:${port}`;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = require('minio');
      this.client = new Client({
        endPoint: endpoint,
        port,
        useSSL,
        accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
        secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
      });
    } catch {
      this.client = null;
    }
  }

  async onModuleInit() {
    if (!this.client) return;
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) await this.client.makeBucket(this.bucket, 'eu-central-1');
    } catch {
      // Non-fatal at startup — will fail on first upload if MinIO is unavailable
    }
  }

  async upload(orgId: string, file: UploadFile, workOrderId?: string): Promise<{ fileId: string; url: string; filename: string }> {
    if (!this.client) throw new InternalServerErrorException('Сервіс файлів недоступний');

    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new BadRequestException('Недозволений формат файлу');

    if (workOrderId) {
      const wo = await this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!wo) throw new NotFoundException('Наряд не знайдено');
    }

    const fileId = crypto.randomUUID();
    const folder = workOrderId ? `org/${orgId}/work-orders/${workOrderId}` : `org/${orgId}`;
    const objectName = `${folder}/${fileId}.${ext}`;

    try {
      await this.client.putObject(this.bucket, objectName, file.buffer, file.size, {
        'Content-Type': file.mimetype,
      });
    } catch {
      throw new InternalServerErrorException('Помилка збереження файлу');
    }

    return { fileId, url: `${this.publicUrl}/${this.bucket}/${objectName}`, filename: file.originalname };
  }
}
