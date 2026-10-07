/**
 * BR-SUPPAY-007 — оплата постачальнику НЕ фіскалізується (ПРРО) і НЕ нараховує лояльність.
 *
 * Правило про ВІДСУТНІСТЬ поведінки, тож поведінковим тестом його не зловити: сервіс, який
 * не має черги 'checkbox', неможливо «спіймати на виклику». Тому сторож статичний — читає
 * вихідники модуля і перевіряє, що в них немає жодної ниточки до фіскалізації чи лояльності.
 *
 * ЩО САМЕ ВВАЖАЄТЬСЯ ПОРУШЕННЯМ (імена взяті з коду 2026-10-07):
 *  - імпорт із `modules/payments/` (PaymentsService, PaymentsModule, CheckboxClient,
 *    CheckboxProcessor, CheckboxProvider, VchasnoProvider, FiscalProviderRegistry,
 *    FISCAL_PROVIDERS, CashShiftService) або з `modules/loyalty/` (LoyaltyService,
 *    LoyaltyModule, LoyaltyProcessor);
 *  - будь-яка згадка в КОДІ (не в коментарі) слів checkbox / fiscal / vchasno / loyalty /
 *    ПРРО — це покриває і черги BullMQ `'checkbox'` та `'loyalty'` (`@InjectQueue('checkbox')`,
 *    `registerQueue({ name: 'loyalty' })`), і методи на кшталт `queueEarn`, `fiscalStatus`.
 *
 * ЧОГО ВІН НЕ БАЧИТЬ (свідомо — regex по тексту модуля, не граф викликів):
 *  - транзитивну залежність: якщо фіскалізацію додадуть усередину SettlementsService або
 *    CashService, які цей модуль кличе, — сторож мовчатиме;
 *  - назву черги, зібрану з частин чи винесену в константу з нейтральним іменем;
 *  - код поза текою модуля, який сам підхопить SupplierPayment (processor, listener).
 *
 * Якщо модулю колись справді знадобиться, напр., `cashRegister.isFiscal` — сторож упаде.
 * Це не хибне спрацювання, а привід свідомо переглянути BR-SUPPAY-007 у дос'є.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const MODULE_DIR = __dirname;

/** Продукт-вихідники модуля: усі .ts, крім спеків і фікстур. */
function productSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) productSources(full, out);
    else if (name.endsWith('.ts') && !name.includes('.spec.') && !name.includes('.spec-fixture.'))
      out.push(full);
  }
  return out;
}

/** Коментарі прибираються: «без Checkbox» у поясненні — не порушення. `://` у рядках не чіпає. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN_IMPORT = /(^|\/)(payments|loyalty)(\/|$)/;
const FORBIDDEN_WORD =
  /checkbox|fiscal|vchasno|loyalty|прро|фіскал|лояльн|queueEarn|\bPayments(?:Service|Module)\b|\bCashShiftService\b/i;

/** Порушення BR-SUPPAY-007 у тексті одного файла (порожній масив = чисто). */
function violations(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];

  const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    if (FORBIDDEN_IMPORT.test(m[1]!)) hits.push(`імпорт із забороненого модуля: ${m[1]!}`);
  }

  for (const line of code.split('\n')) {
    if (FORBIDDEN_WORD.test(line)) hits.push(`згадка в коді: ${line.trim().slice(0, 120)}`);
  }
  return hits;
}

describe('BR-SUPPAY-007 — оплата постачальнику без ПРРО і без лояльності', () => {
  const files = productSources(MODULE_DIR);
  const rel = (file: string) => relative(MODULE_DIR, file).split(sep).join('/');

  it('сторож читає справжні вихідники модуля (інакше кейс нижче зелений на порожньому списку)', () => {
    const names = files.map(rel);
    expect(names).toEqual(
      expect.arrayContaining([
        'supplier-payments.service.ts',
        'supplier-payments.module.ts',
        'supplier-payments.controller.ts',
        'supplier-payments.dto.ts',
      ]),
    );
    expect(names.filter(n => n.includes('.spec'))).toEqual([]);
  });

  // guards: BR-SUPPAY-007
  it('жоден вихідник модуля не імпортує і не згадує фіскалізацію (ПРРО) чи лояльність', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of violations(readFileSync(file, 'utf-8')))
        offenders.push(`${rel(file)}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    [`import { PaymentsService } from '../payments/payments.service';`],
    [`import { CheckboxClient } from '../payments/checkbox.client';`],
    [`import { FiscalProviderRegistry } from '../payments/fiscal/fiscal-provider-registry';`],
    [`import { LoyaltyModule } from '../loyalty/loyalty.module';`],
    [`constructor(@InjectQueue('checkbox') private readonly q: Queue) {}`],
    [`BullModule.registerQueue({ name: 'loyalty' }),`],
    [`await this.loyalty.queueEarn(orgId, supplierId, amount, id);`],
    [`data: { fiscalStatus: 'QUEUED' },`],
  ])('детектор бачить порушення: %s', snippet => {
    expect(violations(snippet).length).toBeGreaterThan(0);
  });

  it.each([
    [`import { SupplierPaymentsService } from './supplier-payments.service';`],
    [`import { SettlementsModule } from '../settlements/settlements.module';`],
    [`const x = 1; // без Checkbox (ПРРО) і без лояльності — supplier-side`],
    [`/** Не фіскалізується: LoyaltyService тут не потрібен. */\nexport const y = 2;`],
  ])('детектор не чіпає дозволене: %s', snippet => {
    expect(violations(snippet)).toEqual([]);
  });
});
