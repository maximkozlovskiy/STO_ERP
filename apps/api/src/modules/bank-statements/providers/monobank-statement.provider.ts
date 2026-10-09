import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { kyivYmd } from '../../../common/utils/kyiv-date';
import type { RawTx } from '../bank-reconciliation.service';
import { MonoStatementClient, type StatementItem } from './mono-statement.client';
import type {
  BankStatementProvider,
  BankStatementConfig,
  BankStatementFetchParams,
  BankStatementVerifyResult,
} from './bank-provider.interface';

/**
 * Провайдер банк-виписки «monobank» (personal statement API). Обгортка MonoStatementClient під
 * BankStatementProvider (registry). Auth: персональний X-Token. account = mono account id (НЕ IBAN),
 * MVP бере credentials.accountId (дефолт '0'). params.iban НЕ використовується (mono ідентифікує
 * рахунок через accountId). mapTx — ЗАХИСНА нормалізація StatementItem → RawTx.
 * Напрям — за знаком суми в мінор-одиницях: додатна → IN, від'ємна → OUT (BR-BANK-019).
 */
@Injectable()
export class MonobankStatementProvider implements BankStatementProvider {
  readonly code = 'monobank';
  readonly name = 'monobank';

  private readonly logger = new Logger(MonobankStatementProvider.name);

  constructor(private readonly client: MonoStatementClient) {}

  /** token з кредів (throw якщо не задано). accountId — mono account id (дефолт '0'). */
  private creds(cfg: BankStatementConfig): { token: string; accountId: string } {
    const token = cfg.credentials?.token;
    if (!token) throw new Error('monobank: не задано токен');
    const accountId = cfg.credentials?.accountId ?? '0';
    return { token, accountId };
  }

  async fetchStatements(
    cfg: BankStatementConfig,
    params: BankStatementFetchParams,
  ): Promise<RawTx[]> {
    const { token, accountId } = this.creds(cfg);
    // params.iban НЕ використовується — mono ідентифікує рахунок через accountId.
    const raw = await this.client.fetchStatements({
      apiUrl: cfg.apiUrl,
      token,
      account: accountId,
      from: params.from,
      to: params.to,
    });
    const out: RawTx[] = [];
    for (const item of raw) {
      const tx = this.mapTx(item);
      if (tx) out.push(tx);
    }
    return out;
  }

  /**
   * ЗАХИСНА нормалізація StatementItem → RawTx | null (null → skip).
   *
   * MONEY-CRITICAL: item.amount — у МІНОР-одиницях (копійки), +credit/−debit. amount=|minor|/100
   * (ЛЕГКО ЗАБУТИ — покрито тестом 15000→150.00); знак іде в `direction`, у RawTx сума завжди > 0.
   * time — Unix СЕКУНДИ (мить). operationDate — КИЇВСЬКИЙ календарний день цієї миті як UTC-північ:
   * колонка `@db.Date` зберігає лише дату, і UTC-зріз миті клав би операцію 10.10 о 01:30 за Києвом
   * у 09.10 (BR-BANK-021).
   *
   * MANUAL-VERIFY (звірити назви полів на живих даних): counterName/counterIban/counterEdrpou —
   * реквізити контрагента; comment/description — призначення платежу.
   */
  private mapTx(item: StatementItem): RawTx | null {
    const str = (v: unknown): string | null =>
      v === null || v === undefined ? null : String(v).trim() || null;

    const externalId = str(item?.id);
    if (!externalId) {
      this.logger.warn('monobank: пропущено проводку без id');
      return null;
    }

    const minor = Number(item?.amount);
    // Нуль / NaN → skip: рядок без суми не імпортується (BR-BANK-017).
    if (!Number.isFinite(minor) || minor === 0) return null;
    const direction = minor < 0 ? 'OUT' : 'IN';
    // MONEY-CRITICAL: мінор-одиниці → гривні (÷100); у базу йде модуль.
    const amount = Math.abs(minor) / 100;

    const timeSec = Number(item?.time);
    if (!Number.isFinite(timeSec) || timeSec <= 0) {
      this.logger.warn(`monobank: пропущено проводку id=${externalId} з невалідним time`);
      return null;
    }
    const instant = new Date(timeSec * 1000); // Unix sec → ms
    if (Number.isNaN(instant.getTime())) {
      this.logger.warn(`monobank: пропущено проводку id=${externalId} з невалідною датою`);
      return null;
    }
    const operationDate = new Date(`${kyivYmd(instant)}T00:00:00.000Z`);

    return {
      externalId,
      operationDate,
      direction,
      amount,
      payerName: str(item.counterName),
      payerIban: str(item.counterIban),
      payerEdrpou: str(item.counterEdrpou),
      purpose: str(item.comment) ?? str(item.description),
      rawData: item as unknown as Prisma.InputJsonValue,
    };
  }

  async verifyCredentials(cfg: BankStatementConfig): Promise<BankStatementVerifyResult> {
    try {
      const { token, accountId } = this.creds(cfg);
      // Пробний короткий fetch за 1-2 доби (1 вікно, без rate-limit паузи): валідний токен → 200
      // (навіть на порожньому результаті); битий → client кидає з auth-помилкою.
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await this.client.fetchStatements({
        apiUrl: cfg.apiUrl,
        token,
        account: accountId,
        from: yesterday,
        to: now,
      });
      return { valid: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка перевірки';
      if (/401|403|token|auth|ключ|токен/i.test(msg)) {
        return { valid: false, error: 'Невірний токен' };
      }
      return { valid: false, error: msg };
    }
  }
}
