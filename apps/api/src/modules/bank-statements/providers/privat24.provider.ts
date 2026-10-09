import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { kyivYmd } from '../../../common/utils/kyiv-date';
import type { RawTx } from '../bank-reconciliation.service';
import { Privat24Client } from './privat24.client';
import type {
  BankStatementProvider,
  BankStatementConfig,
  BankStatementFetchParams,
  BankStatementVerifyResult,
} from './bank-provider.interface';

/**
 * Провайдер банк-виписки «Приват24» (Merchant/Autoclient). Обгортка Privat24Client під
 * BankStatementProvider (registry). Auth: заголовки id+token. mapTx — ЗАХИСНА нормалізація сирого
 * рядка Privat → RawTx (fallback-ключі на випадок розбіжності назв полів; невалідний → skip+warn).
 * Напрям — за `TRANTYPE`: `C` → IN, `D` → OUT; невідомий маркер → skip+warn (BR-BANK-019).
 */
@Injectable()
export class Privat24Provider implements BankStatementProvider {
  readonly code = 'privat24';
  readonly name = 'Приват24';

  private readonly logger = new Logger(Privat24Provider.name);

  constructor(private readonly client: Privat24Client) {}

  /** id+token з кредів (throw якщо не задано). merchantId зберігається як `merchantId` (=заголовок id). */
  private creds(cfg: BankStatementConfig): { id: string; token: string } {
    const id = cfg.credentials?.merchantId;
    const token = cfg.credentials?.token;
    if (!id || !token) throw new Error('Приват24: не задано ID мерчанта або токен');
    return { id, token };
  }

  async fetchStatements(
    cfg: BankStatementConfig,
    params: BankStatementFetchParams,
  ): Promise<RawTx[]> {
    const { id, token } = this.creds(cfg);
    const raw = await this.client.fetchTransactions({
      apiUrl: cfg.apiUrl,
      id,
      token,
      iban: params.iban,
      from: params.from,
      to: params.to,
    });
    const out: RawTx[] = [];
    for (const r of raw) {
      const tx = this.mapTx(r);
      if (tx) out.push(tx);
    }
    return out;
  }

  /**
   * ЗАХИСНА нормалізація сирого рядка Privat24 → RawTx | null (null → skip).
   *
   * MANUAL-VERIFY (звірити назви полів на живих даних):
   *  - externalId: REF ?? ref ?? id — унікальний ідентифікатор проводки (немає → skip+warn);
   *  - напрям: TRANTYPE ('C'=credit/вхідні, 'D'=debit/вихідні) ?? direction ('in'/'out');
   *    невідоме значення → skip+warn: вгаданий напрям провів би списання як надходження;
   *  - amount: SUM ?? amount ?? sum — сума проводки, додатна (нульова / від'ємна → skip+warn);
   *  - operationDate: DATE_TIME_DAT_OD_TIM_P ?? DAT_OD ?? date — дата/час проводки;
   *  - payer*: AUT_CNTR_NAM / AUT_CNTR_ACC / AUT_CNTR_CRF — реквізити КОНТРАГЕНТА (платник для
   *    вхідного, отримувач для вихідного). AUT_MY_* — НАШ бік проводки, у payer* не йде ніколи
   *    (BR-BANK-020): до 2026-10-09 саме він лягав у payerIban, і авто-матч шукав нас самих;
   *  - purpose: OSND ?? purpose — призначення платежу.
   */
  private mapTx(raw: Record<string, unknown>): RawTx | null {
    const str = (v: unknown): string | null =>
      v === null || v === undefined ? null : String(v).trim() || null;

    const externalId = str(raw.REF) ?? str(raw.ref) ?? str(raw.id);
    if (!externalId) {
      this.logger.warn('Приват24: пропущено транзакцію без REF/id');
      return null;
    }

    const direction = this.mapDirection(
      str(raw.TRANTYPE) ?? str(raw.trantype) ?? str(raw.direction),
    );
    if (!direction) {
      this.logger.warn(`Приват24: пропущено транзакцію REF=${externalId} з невідомим напрямом`);
      return null;
    }

    // Напрям у Privat24 несе TRANTYPE, сума — додатна. Від'ємна сума суперечить маркеру напряму:
    // такий рядок пропускаємо, а не вгадуємо, який із двох сигналів правдивий.
    const amount = Number(raw.SUM ?? raw.amount ?? raw.sum);
    if (!Number.isFinite(amount) || amount <= 0) {
      this.logger.warn(`Приват24: пропущено транзакцію REF=${externalId} з невалідною сумою`);
      return null;
    }

    const operationDate = this.parseDate(
      raw.DATE_TIME_DAT_OD_TIM_P ?? raw.DAT_OD ?? raw.date ?? raw.operationDate,
    );
    if (!operationDate) {
      this.logger.warn(`Приват24: пропущено транзакцію REF=${externalId} з невалідною датою`);
      return null;
    }

    return {
      externalId,
      operationDate,
      direction,
      amount,
      payerName: str(raw.AUT_CNTR_NAM) ?? str(raw.payerName) ?? str(raw.name),
      payerIban: str(raw.AUT_CNTR_ACC) ?? str(raw.payerIban) ?? str(raw.iban),
      payerEdrpou: str(raw.AUT_CNTR_CRF) ?? str(raw.payerEdrpou) ?? str(raw.edrpou),
      purpose: str(raw.OSND) ?? str(raw.purpose),
      rawData: raw as Prisma.InputJsonValue,
    };
  }

  /** Маркер напряму Privat24 → IN / OUT; невідомий або відсутній → null (рядок пропускається). */
  private mapDirection(marker: string | null): 'IN' | 'OUT' | null {
    switch (marker?.toUpperCase()) {
      case 'C':
      case 'IN':
      case 'CREDIT':
        return 'IN';
      case 'D':
      case 'OUT':
      case 'DEBIT':
        return 'OUT';
      default:
        return null;
    }
  }

  /**
   * Парсинг дати Privat24. MANUAL-VERIFY формат: Privat зазвичай віддає 'DD.MM.YYYY HH:mm:ss' або
   * 'DD-MM-YYYY'. Пробуємо (а) DD.MM.YYYY[ HH:mm:ss]; (б) DD-MM-YYYY; (в) нативний Date.parse (ISO).
   */
  private parseDate(value: unknown): Date | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;

    // DD.MM.YYYY[ HH:mm:ss] або DD-MM-YYYY[ HH:mm:ss]
    const m = /^(\d{2})[.-](\d{2})[.-](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) {
      const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m;
      const y = Number(yyyy);
      const mo = Number(mm) - 1;
      const day = Number(dd);
      const d = new Date(Date.UTC(y, mo, day, Number(hh), Number(mi), Number(ss)));
      // Rollover-guard (як у BankStatementParserService.parseDate): неіснуючу дату (31.02 →
      // 03-02, невисокосний 29.02 → 03-01) JS «перекочує» замість NaN, що тихо зіпсувало б
      // operationDate (визначає курс для amountBase). Звіряємо компоненти → відкидаємо rollover.
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== day) {
        return null;
      }
      return Number.isNaN(d.getTime()) ? null : d;
    }

    // (в) ISO fallback. Той самий rollover-guard, що й у гілці (а) / BankStatementParserService:
    // нативний new Date('2024-02-31') НЕ дає NaN, а тихо перекочує у 03-02 (а '2024/02/31',
    // '2024-02-31T00:00:00' — ще й у локальну tz) → зіпсована operationDate (визначає курс для
    // amountBase). Для ISO date-only парсимо компоненти явно й звіряємо; повний ISO з зоною (Z/±hh)
    // однозначний → віддаємо нативному парсеру.
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (isoDate) {
      const y = Number(isoDate[1]);
      const mo = Number(isoDate[2]) - 1;
      const day = Number(isoDate[3]);
      const d = new Date(Date.UTC(y, mo, day));
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== day) {
        return null;
      }
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // Повний ISO — це МИТЬ, а не настінний час: у `@db.Date` іде її київський день (BR-BANK-021).
    const instant = new Date(s);
    return Number.isNaN(instant.getTime()) ? null : new Date(`${kyivYmd(instant)}T00:00:00.000Z`);
  }

  async verifyCredentials(cfg: BankStatementConfig): Promise<BankStatementVerifyResult> {
    try {
      const { id, token } = this.creds(cfg);
      // Пробний короткий fetch за вчорашнє вікно (валідний id/token → 200 навіть на порожньому
      // результаті; невалідний → client кидає з auth-помилкою у тілі).
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await this.client.fetchTransactions({
        apiUrl: cfg.apiUrl,
        id,
        token,
        // Синтетичний IBAN — Privat відхилить за auth ДО перевірки рахунку, якщо креди биті.
        iban: 'UA000000000000000000000000000',
        from: yesterday,
        to: now,
      });
      return { valid: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка перевірки';
      if (/401|403|token|auth|ключ|токен/i.test(msg)) {
        return { valid: false, error: 'Невірний ID або токен' };
      }
      return { valid: false, error: msg };
    }
  }
}
