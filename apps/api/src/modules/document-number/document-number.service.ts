import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType } from '@prisma/client';

@Injectable()
export class DocumentNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increment and return the next document number.
   * Uses SELECT FOR UPDATE to prevent TOCTOU race conditions under concurrent requests.
   */
  async next(orgId: string, documentType: DocumentType, _tx?: unknown): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const configs = await tx.$queryRaw<
        Array<{
          id: string;
          prefix: string | null;
          include_date: boolean;
          separator: string;
          padding: number;
          current_seq: bigint;
          reset_period: string;
          last_reset_year: number | null;
          last_reset_month: number | null;
          updated_at: Date;
        }>
      >`
        SELECT id, prefix, include_date, separator, padding,
               current_seq, reset_period, last_reset_year, last_reset_month, updated_at
        FROM document_number_configs
        WHERE org_id = ${orgId}::uuid
          AND document_type = ${documentType}::"DocumentType"
        FOR UPDATE
      `;

      if (!configs.length) {
        throw new NotFoundException(`Конфігурацію нумерації для "${documentType}" не знайдено`);
      }

      const cfg = configs[0];
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;

      const needsYearlyReset =
        cfg.reset_period === 'YEARLY' &&
        cfg.last_reset_year !== null &&
        cfg.last_reset_year !== currentYear;

      const needsMonthlyReset =
        cfg.reset_period === 'MONTHLY' &&
        (cfg.last_reset_year !== currentYear || cfg.last_reset_month !== currentMonth);

      const isReset = needsYearlyReset || needsMonthlyReset;
      const newSeq = isReset ? 1n : BigInt(cfg.current_seq) + 1n;

      await tx.$executeRaw`
        UPDATE document_number_configs
        SET current_seq       = ${newSeq},
            last_reset_year   = ${currentYear},
            last_reset_month  = ${currentMonth},
            updated_at        = NOW()
        WHERE id = ${cfg.id}::uuid
      `;

      const seq = Number(newSeq);
      const seqStr = String(seq).padStart(cfg.padding, '0');

      if (cfg.include_date) {
        const prefix = cfg.prefix ? `${cfg.prefix}${cfg.separator}` : '';
        return `${prefix}${currentYear}${cfg.separator}${seqStr}`;
      }

      const prefix = cfg.prefix ? `${cfg.prefix}${cfg.separator}` : '';
      return `${prefix}${seqStr}`;
    });
  }
}
