import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class FilesService {
  private readonly endpoint: string;
  private readonly port: number;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly bucket = 'sto-erp';
  private readonly useSSL: boolean;

  constructor(private readonly config: ConfigService) {
    this.endpoint = config.get<string>('MINIO_ENDPOINT') ?? 'localhost';
    this.port = parseInt(config.get<string>('MINIO_PORT') ?? '9000', 10);
    this.accessKey = config.get<string>('MINIO_ACCESS_KEY') ?? 'stoerp';
    this.secretKey = config.get<string>('MINIO_SECRET_KEY') ?? 'stoerp_secret';
    this.useSSL = config.get<string>('MINIO_USE_SSL') === 'true';
  }

  async upload(orgId: string, file: Express.Multer.File, workOrderId?: string): Promise<{ fileId: string; url: string; filename: string }> {
    // Lazy-load minio to avoid bundling issues if not installed
    let Client: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const minio = require('minio');
      Client = minio.Client;
    } catch {
      throw new InternalServerErrorException('Сервіс файлів недоступний');
    }

    const client = new Client({
      endPoint: this.endpoint,
      port: this.port,
      useSSL: this.useSSL,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    });

    const fileId = crypto.randomUUID();
    const ext = file.originalname.split('.').pop() ?? 'jpg';
    const folder = workOrderId ? `work-orders/${workOrderId}` : `org/${orgId}`;
    const objectName = `${folder}/${fileId}.${ext}`;

    try {
      // Ensure bucket exists
      const exists = await client.bucketExists(this.bucket);
      if (!exists) {
        await client.makeBucket(this.bucket, 'eu-central-1');
      }

      await client.putObject(this.bucket, objectName, file.buffer, file.size, {
        'Content-Type': file.mimetype,
      });
    } catch {
      throw new InternalServerErrorException('Помилка збереження файлу');
    }

    const protocol = this.useSSL ? 'https' : 'http';
    const url = `${protocol}://${this.endpoint}:${this.port}/${this.bucket}/${objectName}`;

    return { fileId, url, filename: file.originalname };
  }
}
