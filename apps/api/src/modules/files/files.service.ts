import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { translateError } from '@sto/shared';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';

/**
 * Типовий тайм-аут `getObject`: сховище, що зависло (не впало), не тримає друк документа —
 * за цей час читання обривається помилкою, і той, хто кличе, працює без файла.
 */
export const GET_OBJECT_TIMEOUT_MS = 5_000;

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
  private readonly bucket: string;
  private client: {
    bucketExists(name: string): Promise<boolean>;
    makeBucket(name: string, region: string): Promise<void>;
    setBucketPolicy(bucket: string, policy: string): Promise<void>;
    putObject(
      bucket: string,
      object: string,
      stream: Buffer,
      size: number,
      meta: Record<string, string>,
    ): Promise<unknown>;
    presignedGetObject(bucket: string, object: string, expiry: number): Promise<string>;
    getObject(bucket: string, object: string): Promise<NodeJS.ReadableStream>;
    removeObject(bucket: string, object: string): Promise<void>;
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
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'sto-files';

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

  /**
   * D1: readiness-перевірка MinIO для /health/ready. bucketExists — легкий round-trip до сховища.
   * false якщо клієнт не сконфігурований або MinIO недоступний.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      return await this.client.bucketExists(this.bucket);
    } catch {
      return false;
    }
  }

  async onModuleInit() {
    if (!this.client) return;
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) await this.client.makeBucket(this.bucket, 'eu-central-1');
      // T7: публічний read ЛИШЕ для `org/*/public/*` (логотипи — грузяться прямим <img src>).
      // Раніше було `org/*` → УСІ файли (фото авто клієнтів, документи наряду) world-readable за
      // передбачуваним шляхом. Медіа наряду й так віддається через presigned URL (getSignedUrl,
      // work-order-media.service), тож публічний read для них не потрібен — звужуємо до public-префікса.
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${this.bucket}/org/*/public/*`],
          },
        ],
      });
      await this.client.setBucketPolicy(this.bucket, policy);
    } catch {
      // Non-fatal at startup — will fail on first upload if MinIO is unavailable
    }
  }

  async upload(
    orgId: string,
    file: UploadFile,
    workOrderId?: string,
  ): Promise<{ fileId: string; url: string; filename: string }> {
    if (!this.client)
      throw new InternalServerErrorException(
        translateError('err.file.serviceUnavailable', getLocale()),
      );

    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext))
      throw new BadRequestException(translateError('err.file.disallowedFormat', getLocale()));

    if (workOrderId) {
      const wo = await this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!wo)
        throw new NotFoundException(translateError('err.file.workOrderNotFound', getLocale()));
    }

    const fileId = crypto.randomUUID();
    // T7: файли без workOrderId (логотипи org) кладемо у `public/` підпапку — саме її (і лише її)
    // покриває public-read bucket-policy. Медіа наряду (workOrderId) — приватне, віддається presigned.
    const folder = workOrderId ? `org/${orgId}/work-orders/${workOrderId}` : `org/${orgId}/public`;
    const objectName = `${folder}/${fileId}.${ext}`;

    try {
      await this.client.putObject(this.bucket, objectName, file.buffer, file.size, {
        'Content-Type': file.mimetype,
      });
    } catch {
      throw new InternalServerErrorException(translateError('err.file.saveFailed', getLocale()));
    }

    return {
      fileId,
      url: `${this.publicUrl}/${this.bucket}/${objectName}`,
      filename: file.originalname,
    };
  }

  async uploadRaw(buffer: Buffer, objectName: string, mimeType: string): Promise<void> {
    if (!this.client)
      throw new InternalServerErrorException(
        translateError('err.file.serviceUnavailable', getLocale()),
      );
    try {
      await this.client.putObject(this.bucket, objectName, buffer, buffer.length, {
        'Content-Type': mimeType,
      });
    } catch {
      throw new InternalServerErrorException(translateError('err.file.saveFailed', getLocale()));
    }
  }

  async getSignedUrl(objectName: string, expirySeconds = 3600): Promise<string> {
    if (!this.client) {
      // Fallback: return direct public URL when MinIO client not available
      return `${this.publicUrl}/${this.bucket}/${objectName}`;
    }
    try {
      return await this.client.presignedGetObject(this.bucket, objectName, expirySeconds);
    } catch {
      return `${this.publicUrl}/${this.bucket}/${objectName}`;
    }
  }

  /**
   * Прочитати об'єкт сховища в пам'ять — для серверного використання (логотип у шапці PDF).
   * Читає не більше `maxBytes`: більший об'єкт перериває читання й кидає помилку, щоб
   * випадково завеликий файл не тягнувся в пам'ять цілком. Усе читання (запит і потік) — не
   * довше за `timeoutMs`: зависле сховище дає помилку, а потік закривається. Помилки — звичайні
   * `Error` (внутрішній виклик, не HTTP): той, хто кличе, сам вирішує, що робити без файла.
   */
  async getObject(
    objectName: string,
    maxBytes: number,
    timeoutMs: number = GET_OBJECT_TIMEOUT_MS,
  ): Promise<Buffer> {
    const client = this.client;
    if (!client) throw new Error('MinIO client is not configured');
    type Destroyable = NodeJS.ReadableStream & { destroy?: () => void };
    let stream: Destroyable | null = null;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const read = async (): Promise<Buffer> => {
      const opened: Destroyable = await client.getObject(this.bucket, objectName);
      stream = opened;
      // Потік відкрився вже після тайм-ауту — закрити, щоб не лишати з'єднання сховища.
      if (timedOut) {
        opened.destroy?.();
        throw new Error(`Object ${objectName} read timed out after ${timeoutMs} ms`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of opened) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) {
          opened.destroy?.();
          throw new Error(`Object ${objectName} exceeds ${maxBytes} bytes`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    };

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        (stream)?.destroy?.();
        reject(new Error(`Object ${objectName} read timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async deleteObject(objectName: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.removeObject(this.bucket, objectName);
    } catch {
      // Non-fatal — record will still be deleted from DB
    }
  }
}
