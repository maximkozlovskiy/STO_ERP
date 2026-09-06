import { Injectable, Logger } from '@nestjs/common';
import type { DeliveryProvider } from './delivery-provider.interface';
import { NovaPoshtaProvider } from './nova-poshta.provider';

/**
 * Реєстр служб доставки. Додати нову службу = додати impl у конструктор.
 * nova-poshta-polling.processor та delivery-providers-endpoints звертаються сюди через
 * `get(code)` / `list()`, тож жоден хардкод 'novaposhta' більше не потрібен.
 */
@Injectable()
export class DeliveryProviderRegistry {
  private readonly logger = new Logger(DeliveryProviderRegistry.name);
  private readonly providers = new Map<string, DeliveryProvider>();

  constructor(novaPoshta: NovaPoshtaProvider) {
    this.register(novaPoshta);
  }

  private register(p: DeliveryProvider): void {
    this.providers.set(p.code, p);
  }

  /** Провайдер за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): DeliveryProvider | null {
    const p = this.providers.get(code);
    if (!p) this.logger.warn(`Невідома служба доставки: ${code}`);
    return p ?? null;
  }

  /** Метадані всіх служб для UI (без кредів). */
  list(): Array<{ code: string; name: string }> {
    return [...this.providers.values()].map(p => ({ code: p.code, name: p.name }));
  }
}
