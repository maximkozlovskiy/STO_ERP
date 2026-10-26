import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { FilesService } from '../files/files.service';
import { PdfService, type OrgPrintInfo } from './pdf.service';

/** Найбільший логотип, який іде в шапку документа. Більший — шапка без логотипа. */
export const LOGO_MAX_BYTES = 1024 * 1024;
/** Логотип у кеші живе добу; новий логотип має новий URL, тож і новий ключ. */
export const LOGO_CACHE_TTL_SECONDS = 24 * 60 * 60;
/** Скільки чекати сховище з логотипом: зависле сховище не затримує друк довше. */
export const LOGO_READ_TIMEOUT_MS = 5_000;
/**
 * Позначка в кеші замість логотипа, який pdfmake не прийняв: наступні друки до кінця TTL не
 * читають сховище й не будують PDF двічі (повтор без логотипа в `PdfService.render`).
 */
export const LOGO_REJECTED = 'rejected';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Тип зображення за першими байтами (не за розширенням і не за Content-Type). */
export function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length >= PNG_SIGNATURE.length && buf.subarray(0, 8).equals(PNG_SIGNATURE))
    return 'image/png';
  if (buf.length >= JPEG_SIGNATURE.length && buf.subarray(0, 3).equals(JPEG_SIGNATURE))
    return 'image/jpeg';
  return null;
}

/**
 * Ключ об'єкта сховища з публічного URL логотипа. Логотип організації лежить у
 * `org/<orgId>/public/<файл>` (FilesService.upload без наряду); логотипи, завантажені до
 * розділення на `public/` (T7), — прямо в `org/<orgId>/<файл>` (так лежить логотип dev-бази).
 * URL до нього — будь-який `MINIO_PUBLIC_URL` (може мати свій префікс шляху). Беремо частину
 * шляху від `org/<orgId>/` — лише СВОЄЇ організації і лише ім'я файла одним сегментом (з
 * необов'язковим `public/` перед ним): чужий об'єкт, медіа наряду (`work-orders/<id>/…`) чи
 * довільний шлях (logoUrl — вільний рядок у PATCH /settings/org-info) не читаються.
 */
export function logoObjectName(logoUrl: string, orgId: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(logoUrl).pathname);
  } catch {
    return null;
  }
  const prefix = `/org/${orgId}/`;
  const at = pathname.indexOf(prefix);
  if (at < 0) return null;
  const rest = pathname.slice(at + prefix.length);
  const m = /^(public\/)?([A-Za-z0-9._-]+)$/.exec(rest);
  if (!m || rest.includes('..')) return null;
  return `org/${orgId}/${rest}`;
}

/**
 * Реквізити організації для шапки друкованих документів (наряд-замовлення, рахунок, акт
 * виконаних робіт, акт звірки): назва, ЄДРПОУ, ІПН, адреса, телефон, e-mail, основний
 * банківський рахунок і логотип.
 *
 * Логотип береться зі сховища за ключем (не HTTP-запитом на зовнішній URL), лише PNG/JPEG до
 * 1 МБ, читання не довше `LOGO_READ_TIMEOUT_MS`. Перед кешем (Redis, за `logoUrl`, на добу)
 * логотип проходить пробний рендер pdfmake; не прийнятий кешується позначкою `LOGO_REJECTED`.
 * Будь-яка проблема з логотипом — шапка без нього і попередження в лог: документ друкується завжди.
 */
@Injectable()
export class OrgPrintInfoService {
  private readonly logger = new Logger(OrgPrintInfoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly cache: CacheService,
    private readonly pdf: PdfService,
  ) {}

  async get(orgId: string): Promise<OrgPrintInfo> {
    const org = await this.prisma.organisation.findFirst({
      where: { id: orgId },
      select: {
        name: true,
        edrpou: true,
        ipn: true,
        legalAddress: true,
        actualAddress: true,
        phone: true,
        email: true,
        logoUrl: true,
        primaryBankAccount: {
          select: {
            orgId: true,
            deletedAt: true,
            ibanUA: true,
            bankName: true,
            mfo: true,
            edrpou: true,
          },
        },
      },
    });
    if (!org) return { name: '' };

    const ba = org.primaryBankAccount;
    // Рахунок мусить бути своїм і не видаленим: видалений рахунок у реквізитах — це гроші,
    // надіслані на закритий рахунок.
    const bank =
      ba && ba.orgId === orgId && !ba.deletedAt
        ? { iban: ba.ibanUA, bankName: ba.bankName, mfo: ba.mfo, edrpou: ba.edrpou }
        : null;

    return {
      name: org.name,
      edrpou: org.edrpou,
      ipn: org.ipn,
      address: org.actualAddress || org.legalAddress || null,
      phone: org.phone,
      email: org.email,
      bank,
      logo: org.logoUrl ? await this.loadLogo(orgId, org.logoUrl) : null,
    };
  }

  /** data URL логотипа для pdfmake або null (шапка без логотипа). Ніколи не кидає. */
  private async loadLogo(orgId: string, logoUrl: string): Promise<string | null> {
    const cacheKey = `pdf:logo:${orgId}:${createHash('sha256').update(logoUrl).digest('hex')}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached === LOGO_REJECTED) return null;
    if (cached) return cached;

    const objectName = logoObjectName(logoUrl, orgId);
    if (!objectName) {
      this.logger.warn(`PDF logo skipped for org ${orgId}: URL is not an org public object`);
      return null;
    }
    try {
      const buf = await this.files.getObject(objectName, LOGO_MAX_BYTES, LOGO_READ_TIMEOUT_MS);
      const mime = detectImageMime(buf);
      if (!mime) {
        this.logger.warn(`PDF logo skipped for org ${orgId}: not a PNG/JPEG image`);
        return null;
      }
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      if (!(await this.pdf.probeImage(dataUrl))) {
        this.logger.warn(`PDF logo skipped for org ${orgId}: image rejected by PDF renderer`);
        await this.cache.set(cacheKey, LOGO_REJECTED, LOGO_CACHE_TTL_SECONDS);
        return null;
      }
      await this.cache.set(cacheKey, dataUrl, LOGO_CACHE_TTL_SECONDS);
      return dataUrl;
    } catch (e: unknown) {
      this.logger.warn(
        `PDF logo skipped for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }
}
