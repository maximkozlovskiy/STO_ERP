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

  private shouldResetSequence(period: string, lastUpdated: Date, now: Date): boolean {
    if (period === 'YEARLY') {
      return lastUpdated.getFullYear() < now.getFullYear();
    }
    if (period === 'MONTHLY') {
      return (
        lastUpdated.getFullYear() < now.getFullYear() ||
        lastUpdated.getMonth() < now.getMonth()
      );
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
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

    return format
      .replace('YYYY', String(y))
      .replace('MM', m)
      .replace('DD', d)
      .replace('YYYYMMDD', `${y}${m}${d}`);
  }
}
