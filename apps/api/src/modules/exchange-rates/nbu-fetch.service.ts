import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from './exchange-rates.service';

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let nbuRates: NbuRateEntry[];
    try {
      const resp = await fetch(`${NBU_URL}?start=${yyyymmdd}&end=${yyyymmdd}&json`, {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`NBU API відповів статусом ${resp.status}`);
      nbuRates = (await resp.json()) as NbuRateEntry[];
    } finally {
      clearTimeout(timer);
    }

    const nbuMap = new Map<string, NbuRateEntry>(nbuRates.map(r => [r.cc, r]));

    let fetched = 0;
    let errors = 0;
    for (const currency of currencies) {
      const entry = nbuMap.get(currency.code);
      if (!entry) {
        this.logger.warn(`NBU: курс для коду ${currency.code} не знайдено`);
        errors++;
        continue;
      }
      try {
        const markup = currency.nbuMarkupPercent != null ? Number(currency.nbuMarkupPercent) : 0;
        const finalRate = entry.rate * (1 + markup / 100);

        try {
          await this.exchangeRatesService.create(orgId, {
            currencyId: currency.id,
            date: kyivDate,
            rate: finalRate,
            coefficient: 1,
          });
        } catch (e) {
          // ConflictException = курс на сьогодні вже існує — ідемпотентно
          if (e instanceof ConflictException) {
            this.logger.debug(`NBU: курс ${currency.code} на ${kyivDate} вже існує — пропускаємо`);
          } else {
            throw e;
          }
        }
        fetched++;
      } catch (e) {
        this.logger.warn(
          `NBU: помилка збереження курсу ${currency.code}: ${e instanceof Error ? e.message : e}`,
        );
        errors++;
      }
    }

    this.logger.log(`NBU fetch org=${orgId}: fetched=${fetched}, errors=${errors}`);
    return { fetched, errors };
  }
}
