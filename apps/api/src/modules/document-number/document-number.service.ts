import { Injectable, NotFoundException } from '@nestjs/common';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType } from '@prisma/client';

// Module-level Intl singleton — `new Intl.DateTimeFormat()` is expensive (locale-data init).
// Called on every document number generation (WO/Invoice/PO/SD/CompletionAct/ReconciliationAct create);
// hoisting prevents allocating a new formatter on the hot create-document path.
const KYIV_YEAR_MONTH_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
});

@Injectable()
export class DocumentNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increment and return the next document number.
   * Uses SELECT FOR UPDATE to prevent TOCTOU race conditions under concurrent requests.
   */
  async next(orgId: string, documentType: DocumentType, _tx?: unknown): Promise<string> {
    return this.prisma.$transaction(
      async tx => {
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
        const [currentYear, currentMonth] = KYIV_YEAR_MONTH_FMT.format(now).split('-').map(Number);

        // NULL lastResetYear means the counter has never been anchored to a period.
        // For a YEARLY/MONTHLY config that must be treated as "needs reset" so the
        // FIRST number of the current period starts at 1 — otherwise a config with a
        // non-zero currentSeq (legacy import, admin-set start seq) would keep
        // incrementing across the year boundary instead of restarting.
        // The old `cfg.lastResetYear !== null &&` guard on YEARLY made it asymmetric
        // with MONTHLY (which already resets on NULL) and left such configs never
        // resetting per year.
        const needsYearlyReset = cfg.resetPeriod === 'YEARLY' && cfg.lastResetYear !== currentYear;

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
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: SELECT FOR UPDATE + UPDATE in one tx, well below Prisma default 30s
  }
}
