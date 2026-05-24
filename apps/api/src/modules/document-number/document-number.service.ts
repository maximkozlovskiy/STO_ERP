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
      // Prisma schema uses camelCase without @map, so Postgres columns are camelCase.
      // Raw SQL must quote camelCase identifiers — otherwise Postgres folds to lowercase
      // (`org_id` won't match `"orgId"`).
      const configs = await tx.$queryRaw<
        Array<{
          id: string;
          prefix: string | null;
          includeDate: boolean;
          separator: string;
          padding: number;
          currentSeq: bigint;
          resetPeriod: string;
          lastResetYear: number | null;
          lastResetMonth: number | null;
          updatedAt: Date;
        }>
      >`
        SELECT id, prefix, "includeDate", separator, padding,
               "currentSeq", "resetPeriod", "lastResetYear", "lastResetMonth", "updatedAt"
        FROM document_number_configs
        WHERE "orgId" = ${orgId}::uuid
          AND "documentType" = ${documentType}::"DocumentType"
        FOR UPDATE
        LIMIT 1
      `;

      if (!configs.length) {
        throw new NotFoundException(`Конфігурацію нумерації для "${documentType}" не знайдено`);
      }

      const cfg = configs[0];
      const now = new Date();
      const kyivFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit',
      });
      const [currentYear, currentMonth] = kyivFmt.format(now).split('-').map(Number);

      const needsYearlyReset =
        cfg.resetPeriod === 'YEARLY' &&
        cfg.lastResetYear !== null &&
        cfg.lastResetYear !== currentYear;

      const needsMonthlyReset =
        cfg.resetPeriod === 'MONTHLY' &&
        (cfg.lastResetYear !== currentYear || cfg.lastResetMonth !== currentMonth);

      const isReset = needsYearlyReset || needsMonthlyReset;
      const newSeq = isReset ? 1n : BigInt(cfg.currentSeq) + 1n;

      await tx.$executeRaw`
        UPDATE document_number_configs
        SET "currentSeq"      = ${newSeq},
            "lastResetYear"   = ${currentYear},
            "lastResetMonth"  = ${currentMonth},
            "updatedAt"       = NOW()
        WHERE id = ${cfg.id}::uuid
      `;

      const seq = Number(newSeq);
      const seqStr = String(seq).padStart(cfg.padding, '0');

      if (cfg.includeDate) {
        const prefix = cfg.prefix ? `${cfg.prefix}${cfg.separator}` : '';
        return `${prefix}${currentYear}${cfg.separator}${seqStr}`;
      }

      const prefix = cfg.prefix ? `${cfg.prefix}${cfg.separator}` : '';
      return `${prefix}${seqStr}`;
    });
  }
}
