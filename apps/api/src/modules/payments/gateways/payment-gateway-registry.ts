import { Injectable, Logger, Inject } from '@nestjs/common';
import { type PaymentGateway, PAYMENT_GATEWAYS } from './payment-gateway.interface';

/**
 * Реєстр платіжних шлюзів (еквайринг QR). Шлюзи інжектяться масивом через multi-provider DI-токен
 * PAYMENT_GATEWAYS — додати новий = зареєструвати impl у payments.module
 * (`{ provide: PAYMENT_GATEWAYS, useExisting: <Impl>, multi: true }`), сам реєстр НЕ чіпається
 * (Open/Closed + DIP). online-payment.service та payment-polling.processor звертаються через get()/list().
 */
@Injectable()
export class PaymentGatewayRegistry {
  private readonly logger = new Logger(PaymentGatewayRegistry.name);
  private readonly gateways = new Map<string, PaymentGateway>();

  constructor(@Inject(PAYMENT_GATEWAYS) gateways: PaymentGateway[]) {
    for (const g of gateways) this.gateways.set(g.code, g);
  }

  get(code: string): PaymentGateway | null {
    const g = this.gateways.get(code);
    if (!g) this.logger.warn(`Невідомий платіжний шлюз: ${code}`);
    return g ?? null;
  }

  list(): Array<{ code: string; name: string }> {
    return [...this.gateways.values()].map(g => ({ code: g.code, name: g.name }));
  }
}
