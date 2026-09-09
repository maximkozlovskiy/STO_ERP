import { Injectable, Logger, Inject } from '@nestjs/common';
import { type DeliveryProvider, DELIVERY_PROVIDERS } from './delivery-provider.interface';

/**
 * Реєстр служб доставки. Провайдери інжектяться масивом через multi-provider DI-токен
 * DELIVERY_PROVIDERS — додати нову службу = зареєструвати impl у purchase-orders.module
 * (`{ provide: DELIVERY_PROVIDERS, useExisting: <Impl>, multi: true }`), сам реєстр НЕ чіпається
 * (Open/Closed + DIP). nova-poshta-polling.processor та delivery-endpoints звертаються через get()/list().
 */
@Injectable()
export class DeliveryProviderRegistry {
  private readonly logger = new Logger(DeliveryProviderRegistry.name);
  private readonly providers = new Map<string, DeliveryProvider>();

  constructor(@Inject(DELIVERY_PROVIDERS) providers: DeliveryProvider[]) {
    for (const p of providers) this.providers.set(p.code, p);
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
