import { Injectable, Logger, Inject } from '@nestjs/common';
import { type FiscalProvider, FISCAL_PROVIDERS } from './fiscal-provider.interface';

/**
 * Реєстр провайдерів ПРРО (фіскалізація). Провайдери інжектяться масивом через multi-provider
 * DI-токен FISCAL_PROVIDERS — додати нового = зареєструвати impl у payments.module
 * (`{ provide: FISCAL_PROVIDERS, useExisting: <Impl>, multi: true }`), сам реєстр НЕ чіпається
 * (Open/Closed + DIP: реєстр залежить від абстракції FiscalProvider[], не від конкретних класів).
 * cash-shift.service та fiscal.processor звертаються сюди через `get(code)` / `list()`.
 */
@Injectable()
export class FiscalProviderRegistry {
  private readonly logger = new Logger(FiscalProviderRegistry.name);
  private readonly providers = new Map<string, FiscalProvider>();

  constructor(@Inject(FISCAL_PROVIDERS) providers: FiscalProvider[]) {
    for (const p of providers) this.providers.set(p.code, p);
  }

  /** Провайдер за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): FiscalProvider | null {
    const p = this.providers.get(code);
    if (!p) this.logger.warn(`Невідомий провайдер ПРРО: ${code}`);
    return p ?? null;
  }

  /** Метадані всіх провайдерів для UI (без кредів). */
  list(): Array<{ code: string; name: string }> {
    return [...this.providers.values()].map(p => ({ code: p.code, name: p.name }));
  }
}
