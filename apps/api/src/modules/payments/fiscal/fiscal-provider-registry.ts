import { Injectable, Logger } from '@nestjs/common';
import type { FiscalProvider } from './fiscal-provider.interface';
import { CheckboxProvider } from './checkbox.provider';
import { VchasnoProvider } from './vchasno.provider';

/**
 * Реєстр провайдерів ПРРО (фіскалізація). Додати нового провайдера = додати impl у конструктор.
 * cash-shift.service та fiscal.processor звертаються сюди через `get(code)` / `list()`,
 * тож жоден хардкод 'checkbox' більше не потрібен.
 */
@Injectable()
export class FiscalProviderRegistry {
  private readonly logger = new Logger(FiscalProviderRegistry.name);
  private readonly providers = new Map<string, FiscalProvider>();

  constructor(checkbox: CheckboxProvider, vchasno: VchasnoProvider) {
    this.register(checkbox);
    this.register(vchasno);
  }

  private register(p: FiscalProvider): void {
    this.providers.set(p.code, p);
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
