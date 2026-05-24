import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType } from '@prisma/client';

@Injectable()
export class DocumentNumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increment and return the next document number.
   * Uses SELECT FOR UPDATE to prevent concurrent duplicates.
   */
  async next(orgId: string, docType: DocumentType): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the config row
      const configs = await tx.$queryRaw<
        Array<{
          id: string;
          prefix: string | null;
          include_date: boolean;
          date_format: string;
          separator: string;
          padding: number;
          current_seq: bigint;
          reset_period: string;
          updated_at: Date;
        }>
      >`
        SELECT id, prefix, include_date, date_format, separator, padding,
               current_seq, reset_period, updated_at
        FROM document_number_configs
        WHERE org_id = ${orgId}::uuid
          AND document_type = ${docType}::"DocumentType"
        FOR UPDATE
      `;

      if (!configs.length) {
        throw new NotFoundException(
          `Конфігурацію нумерації для "${docType}" не знайдено`,
        );
      }

      const cfg = configs[0];
      const now = new Date();
      let newSeq = BigInt(cfg.current_seq) + 1n;

      // Reset sequence if period has elapsed
      if (cfg.reset_period !== 'NEVER') {
        const shouldReset = this.shouldResetSequence(
          cfg.reset_period,
          cfg.updated_at,
          now,
        );
        if (shouldReset) newSeq = 1n;
      }

      await tx.$executeRaw`
        UPDATE document_number_configs
        SET current_seq = ${newSeq}, updated_at = NOW()
        WHERE id = ${cfg.id}::uuid
      `;

      return this.formatNumber(
        cfg.prefix,
        cfg.include_date,
        cfg.date_format,
        cfg.separator,
        cfg.padding,
        newSeq,
        now,
      );
    });
  }

  private kyivParts(date: Date): { year: number; month: number; day: number } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const [year, month, day] = fmt.format(date).split('-').map(Number);
    return { year, month, day };
  }

  private shouldResetSequence(period: string, lastUpdated: Date, now: Date): boolean {
    const last = this.kyivParts(lastUpdated);
    const cur = this.kyivParts(now);
    if (period === 'YEARLY') return last.year < cur.year;
    if (period === 'MONTHLY') {
      return last.year < cur.year || (last.year === cur.year && last.month < cur.month);
    }
    return false;
  }

  private formatNumber(
    prefix: string | null,
    includeDate: boolean,
    dateFormat: string,
    separator: string,
    padding: number,
    seq: bigint,
    now: Date,
  ): string {
    const parts: string[] = [];

    if (prefix) parts.push(prefix);

    if (includeDate) {
      parts.push(this.formatDate(dateFormat, now));
    }

    parts.push(String(seq).padStart(padding, '0'));

    return parts.join(separator);
  }

  private formatDate(format: string, date: Date): string {
    const { year: y, month, day } = this.kyivParts(date);
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');

    return format
      .replace('YYYYMMDD', `${y}${m}${d}`)
      .replace('YYYY', String(y))
      .replace('MM', m)
      .replace('DD', d);
  }
}
