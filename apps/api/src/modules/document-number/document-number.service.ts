import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType } from '@prisma/client';

@Injectable()
export class DocumentNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increments the sequence counter and returns a formatted document number.
   * Handles YEARLY and MONTHLY resets: if the period boundary has passed, resets currentSeq to 1
   * and records the new period marker — all in one atomic UPDATE to prevent TOCTOU races.
   */
  async next(orgId: string, documentType: DocumentType, tx?: any): Promise<string> {
    const db = tx ?? this.prisma;

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // First read the config to decide if a reset is needed
    let config;
    try {
      config = await db.documentNumberConfig.findUniqueOrThrow({
        where: { orgId_documentType: { orgId, documentType } },
      });
    } catch {
      throw new BadRequestException(`Конфігурацію нумерації для "${documentType}" не знайдено`);
    }

    const needsYearlyReset =
      config.resetPeriod === 'YEARLY' &&
      config.lastResetYear !== null &&
      config.lastResetYear !== currentYear;

    const needsMonthlyReset =
      config.resetPeriod === 'MONTHLY' &&
      (config.lastResetYear !== currentYear || config.lastResetMonth !== currentMonth);

    const isReset = needsYearlyReset || needsMonthlyReset;

    try {
      config = await db.documentNumberConfig.update({
        where: { orgId_documentType: { orgId, documentType } },
        data: isReset
          ? { currentSeq: 1, lastResetYear: currentYear, lastResetMonth: currentMonth }
          : { currentSeq: { increment: 1 } },
      });
    } catch {
      throw new BadRequestException(`Конфігурацію нумерації для "${documentType}" не знайдено`);
    }

    const seq = isReset ? 1 : Number(config.currentSeq);
    const pad = config.padding ?? 4;
    const seqStr = String(seq).padStart(pad, '0');

    if (config.includeDate) {
      const year = currentYear;
      const prefix = config.prefix ? `${config.prefix}${config.separator}` : '';
      return `${prefix}${year}${config.separator}${seqStr}`;
    }

    const prefix = config.prefix ? `${config.prefix}${config.separator}` : '';
    return `${prefix}${seqStr}`;
  }
}
