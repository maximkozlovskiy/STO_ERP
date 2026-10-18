import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { convertToBase } from '../../../common/utils/currency';
import { ExchangeRatesService } from '../../exchange-rates/exchange-rates.service';

/**
 * Ціна пропозиції → гривня (базова валюта організації) за курсом на момент вибору / підбору
 * (рішення власника 2026-10-18: «замовлення завжди в гривні»; BR-SOFR-006, 007). Курс —
 * `ExchangeRatesService.getRateAsOf` (найближчий не пізніше моменту), без підстановки 1:
 * курсу немає — null, і пропозицію не обирають.
 *
 * Один конвертер на запит: курс кожної валюти читається один раз (`cache`).
 */
@Injectable()
export class SupplierPriceConverter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  forOrg(
    orgId: string,
    at: Date = new Date(),
  ): (currencyCode: string, price: number) => Promise<number | null> {
    let baseCode: Promise<string> | null = null;
    const rates = new Map<string, Promise<{ rate: number; coefficient: number } | null>>();
    const base = () =>
      (baseCode ??= this.exchangeRates.getBaseCurrency(orgId).then(b => b.code.toUpperCase()));
    const rateOf = (code: string) => {
      let p = rates.get(code);
      if (!p) {
        p = this.prisma.currency
          .findFirst({ where: { orgId, code, deletedAt: null }, select: { id: true } })
          .then(c => (c ? this.exchangeRates.getRateAsOf(orgId, c.id, at) : null));
        rates.set(code, p);
      }
      return p;
    };
    return async (currencyCode, price) => {
      const code = (currencyCode || 'UAH').toUpperCase();
      if (code === (await base())) return price;
      const r = await rateOf(code);
      return r ? convertToBase(price, r.rate, r.coefficient) : null;
    };
  }
}
