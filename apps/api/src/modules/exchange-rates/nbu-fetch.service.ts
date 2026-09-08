import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from './exchange-rates.service';
import { validatePublicUrl } from '../../common/utils/url-guard';

interface NbuRateEntry {
  cc: string;
  rate: number;
  exchangedate: string;
}

const NBU_URL = 'https://bank.gov.ua/NBU_Exchange/exchange_site';
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

@Injectable()
export class NbuFetchService {
  private readonly logger = new Logger(NbuFetchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRatesService: ExchangeRatesService,
  ) {}

  async fetchAndUpsertForOrg(orgId: string): Promise<{ fetched: number; errors: number }> {
    const currencies = await this.prisma.currency.findMany({
      where: { orgId, deletedAt: null, nbuFetchEnabled: true },
      select: { id: true, code: true, nbuMarkupPercent: true },
      take: 200,
    });
    if (currencies.length === 0) return { fetched: 0, errors: 0 };

    const kyivDate = KYIV_YMD.format(new Date()); // YYYY-MM-DD
    const yyyymmdd = kyivDate.replace(/-/g, '');

    const urlError = validatePublicUrl(NBU_URL);
    if (urlError) throw new Error(`Невалідний НБУ API URL: ${urlError}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let nbuRates: NbuRateEntry[];
    try {
      const resp = await fetch(`${NBU_URL}?start=${yyyymmdd}&end=${yyyymmdd}&json`, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        throw new Error(`НБУ повернув перенаправлення ${resp.status} — запит відхилено`);
      }
      if (!resp.ok) throw new Error(`NBU API відповів статусом ${resp.status}`);
      nbuRates = (await resp.json()) as NbuRateEntry[];
    } finally {
      clearTimeout(timer);
    }

    const nbuMap = new Map<string, NbuRateEntry>(nbuRates.map(r => [r.cc, r]));

    // sto-optimize: parallel per-currency upsert. Each `exchangeRatesService.create` is
    // independent (own currencyId), idempotent (ConflictException handled), tenant-safe
    // (orgId у where). For 5-15 enabled currencies × ~50ms RTT (PG insert + retry on
    // conflict) — серійно 250-750ms; паралельно — max single insert (~50ms).
    const results = await Promise.all(
      currencies.map(async (currency): Promise<boolean> => {
        const entry = nbuMap.get(currency.code);
        if (!entry) {
          this.logger.warn(`NBU: курс для коду ${currency.code} не знайдено`);
          return false;
        }
        const markup = currency.nbuMarkupPercent != null ? Number(currency.nbuMarkupPercent) : 0;
        const finalRate = entry.rate * (1 + markup / 100);
        try {
          await this.exchangeRatesService.create(orgId, {
            currencyId: currency.id,
            date: kyivDate,
            rate: finalRate,
            coefficient: 1,
          });
          return true;
        } catch (e) {
          if (e instanceof ConflictException) {
            this.logger.debug(`NBU: курс ${currency.code} на ${kyivDate} вже існує — пропускаємо`);
            return true;
          }
          this.logger.warn(
            `NBU: помилка збереження курсу ${currency.code}: ${e instanceof Error ? e.message : e}`,
          );
          return false;
        }
      }),
    );

    const fetched = results.filter(Boolean).length;
    const errors = results.length - fetched;

    this.logger.log(`NBU fetch org=${orgId}: fetched=${fetched}, errors=${errors}`);
    return { fetched, errors };
  }
}
