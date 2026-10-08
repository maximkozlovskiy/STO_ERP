import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money, moneyFromDecimal } from '../../common/utils/money';
import { calcVatOnBase, splitWorkOrderTotal } from '../../common/utils/vat';
import { SettingsService } from '../settings/settings.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

/**
 * Єдине місце, що рахує й пише тотали наряду (BR-WO-007): `totalLabor`, `totalActualLabor`,
 * `totalParts`, `totalNet`, `totalVat`, `totalAmount`, `totalAmountBase`, `rateUsed`.
 *
 * Окремий сервіс, а не приватний метод WorkOrdersService, бо рядки наряду додає не лише він:
 * огляд авто (InspectionService) і XLSX-імпорт запчастин (XlsxService) раніше писали тотали
 * власноруч або не писали взагалі — і сума наряду розходилась із рядками та режимом ПДВ.
 * Викликати ЗАВЖДИ в тій самій транзакції, що змінила рядки.
 */
@Injectable()
export class WorkOrderTotalsService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  async recalc(workOrderId: string, tx: Prisma.TransactionClient, orgId: string): Promise<void> {
    // sto-optimize 2026-06-17 (twin-scan + take cap):
    // (1) Defense-in-depth `take: 1000` — addLine/addPart endpoints не мають
    //     ArrayMaxSize, теоретично lines/parts можуть рости неконтрольовано.
    //     Same upper bound що інші bulk reads у цьому сервісі (reserveParts:802).
    // (2) Single-pass reduce замість twin-scan: раніше `lines.reduce`
    //     викликався двічі по тому ж масиву (totalLabor + totalActualLabor).
    //     Для WO з 50+ рядками — половина CPU/GC роботи у hot path mutation.
    const [lines, partsAgg, wo] = await Promise.all([
      tx.workOrderLine.findMany({
        where: { workOrderId, orgId, deletedAt: null },
        select: { amount: true, actualHours: true, normoHours: true, price: true },
        take: 1000,
      }),
      tx.workOrderPart.aggregate({
        where: { workOrderId, orgId, deletedAt: null },
        _sum: { amount: true },
      }),
      // Мультивалюта (Фаза 3): валюта + дата документа для base-конвертації тоталу.
      tx.workOrder.findFirst({
        where: { id: workOrderId, orgId },
        select: { currencyId: true, documentDate: true },
      }),
    ]);

    // Single-pass: рахуємо totalLabor (planned) і totalActualLabor разом.
    // totalLabor = SUM(amount), totalActualLabor = SUM((actualHours ?? normoHours) × price).
    // sto-simplify: `Number(actualHours ?? normoHours ?? 0)` рівносильно verbose тернаркі
    // бо Prisma Decimal `?? null`-fallback працює на null/undefined (а 0-години у normoHours
    // зустрічається лише при ручному вводі і не змінює sum — 0 × price = 0).
    // Акумулятори сирі (НЕ Money) свідомо: округлення РАЗ у кінці точніше за покрокове —
    // виміряно у money.ts (на сирих значеннях покрокове накопичує помилку ~51%). Бренд
    // ставиться на РЕЗУЛЬТАТ, не на проміжну суму.
    let totalLabor = 0;
    let totalActualLabor = 0;
    for (const l of lines) {
      totalLabor += moneyFromDecimal(l.amount);
      totalActualLabor += Number(l.actualHours ?? l.normoHours ?? 0) * moneyFromDecimal(l.price);
    }
    const totalParts = moneyFromDecimal(partsAgg._sum.amount);
    const totalBase = totalActualLabor + totalParts;

    // A5-money: ПДВ через єдине джерело формули (common/utils/vat) — та сама математика, що в invoices.
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const totalVat = calcVatOnBase(totalBase, vatRate, vatMode);

    // WO-H2: квантуємо всі грошові суми до копійки перед записом у Decimal(12,2) —
    // інакше float-дрейф дає Σ(рядки)≠total і невірну базу для CHARGE при COMPLETED.
    // BR-WO-007: totalAmount — сума ДО СПЛАТИ (її бере CHARGE і рахунок), тож ПДВ у ній є завжди,
    // коли він є взагалі; totalNet — сума без ПДВ. Інваріант: totalNet + totalVat = totalAmount.
    const { totalNet, totalAmount } = splitWorkOrderTotal(money(totalBase), totalVat, vatMode);
    // Мультивалюта (Фаза 3): base-сума тоталу по курсу на дату документа (fallbackToLatest — документний
    // потік). Без currencyId → base (rate=1, base=total). Курс — на documentDate (наряд ведеться у валюті).
    const conv = wo?.currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          wo.currencyId,
          wo.documentDate ?? new Date(),
          totalAmount,
          true,
        )
      : { rateUsed: 1, amountBase: totalAmount };
    await tx.workOrder.update({
      where: { id: workOrderId, orgId },
      data: {
        totalLabor: money(totalLabor),
        totalActualLabor: money(totalActualLabor),
        totalParts: money(totalParts),
        totalNet,
        totalAmount,
        totalVat, // calcVatOnBase уже віддає Money — повторний money() був би шумом
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
      },
    });
  }
}
