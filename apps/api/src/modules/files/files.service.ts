import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class FilesService {
  private readonly endpoint: string;
  private readonly port: number;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly publicUrl: string;
  private readonly bucket = 'sto-erp';
  private readonly useSSL: boolean;

  constructor(private readonly config: ConfigService) {
    this.endpoint = config.getOrThrow<string>('MINIO_ENDPOINT');
    this.port = parseInt(config.getOrThrow<string>('MINIO_PORT'), 10);
    this.accessKey = config.getOrThrow<string>('MINIO_ACCESS_KEY');
    this.secretKey = config.getOrThrow<string>('MINIO_SECRET_KEY');
    this.useSSL = config.get<string>('MINIO_USE_SSL') === 'true';
    // MINIO_PUBLIC_URL is the externally accessible base URL for clients (mobile, browser)
    const protocol = this.useSSL ? 'https' : 'http';
    this.publicUrl = config.get<string>('MINIO_PUBLIC_URL') ?? `${protocol}://${this.endpoint}:${this.port}`;
  }

  async upload(orgId: string, file: UploadFile, workOrderId?: string): Promise<{ fileId: string; url: string; filename: string }> {
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

    const url = `${this.publicUrl}/${this.bucket}/${objectName}`;

    return { fileId, url, filename: file.originalname };
  }
}
