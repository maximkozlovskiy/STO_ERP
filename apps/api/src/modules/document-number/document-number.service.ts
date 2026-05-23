import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType } from '@prisma/client';

@Injectable()
export class DocumentNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increments the sequence counter for a document type and returns
   * a formatted document number. Uses UPDATE ... RETURNING to avoid TOCTOU races.
   */
  async next(orgId: string, documentType: DocumentType, tx?: any): Promise<string> {
    const db = tx ?? this.prisma;

    const config = await db.documentNumberConfig.update({
      where: { orgId_documentType: { orgId, documentType } },
      data: { currentSeq: { increment: 1 } },
    });

    if (!config) {
      throw new BadRequestException(`Конфігурацію нумерації для "${documentType}" не знайдено`);
    }

    const seq = Number(config.currentSeq);
    const pad = config.padding ?? 4;
    const seqStr = String(seq).padStart(pad, '0');

    if (config.includeDate) {
      const year = new Date().getFullYear();
      const prefix = config.prefix ? `${config.prefix}${config.separator}` : '';
      return `${prefix}${year}${config.separator}${seqStr}`;
    }

    const prefix = config.prefix ? `${config.prefix}${config.separator}` : '';
    return `${prefix}${seqStr}`;
  }
}
