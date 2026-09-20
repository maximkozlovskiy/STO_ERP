import { Injectable, Logger, Inject } from '@nestjs/common';
import { type BankStatementProvider, BANK_STATEMENT_PROVIDERS } from './bank-provider.interface';

/**
 * Реєстр банків-провайдерів виписки. Провайдери інжектяться масивом через DI-токен
 * BANK_STATEMENT_PROVIDERS — додати новий банк = зареєструвати impl у bank-statements.module
 * (useFactory-масив), сам реєстр НЕ чіпається (Open/Closed + DIP). bank-statement-pull.processor
 * та контролер звертаються через get()/list().
 */
@Injectable()
export class BankProviderRegistry {
  private readonly logger = new Logger(BankProviderRegistry.name);
  private readonly providers = new Map<string, BankStatementProvider>();

  constructor(@Inject(BANK_STATEMENT_PROVIDERS) providers: BankStatementProvider[]) {
    for (const p of providers) this.providers.set(p.code, p);
  }

  /** Провайдер за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): BankStatementProvider | null {
    const p = this.providers.get(code);
    if (!p) this.logger.warn(`Невідомий банк-провайдер виписки: ${code}`);
    return p ?? null;
  }

  /** Метадані всіх банків для UI (без кредів). */
  list(): Array<{ code: string; name: string }> {
    return [...this.providers.values()].map(p => ({ code: p.code, name: p.name }));
  }
}
