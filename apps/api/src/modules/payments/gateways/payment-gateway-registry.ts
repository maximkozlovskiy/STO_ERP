import { Injectable, Logger } from '@nestjs/common';
import type { PaymentGateway } from './payment-gateway.interface';
import { MonobankGateway } from './monobank.gateway';
import { LiqpayGateway } from './liqpay.gateway';

/**
 * Реєстр платіжних шлюзів (еквайринг). Додати новий шлюз = додати impl у конструктор.
 * online-payment.service та payment-polling.processor звертаються сюди через `get(code)` / `list()`,
 * тож жоден хардкод 'monobank' більше не потрібен.
 */
@Injectable()
export class PaymentGatewayRegistry {
  private readonly logger = new Logger(PaymentGatewayRegistry.name);
  private readonly gateways = new Map<string, PaymentGateway>();

  constructor(monobank: MonobankGateway, liqpay: LiqpayGateway) {
    this.register(monobank);
    this.register(liqpay);
  }

  private register(g: PaymentGateway): void {
    this.gateways.set(g.code, g);
  }

  /** Шлюз за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): PaymentGateway | null {
    const g = this.gateways.get(code);
    if (!g) this.logger.warn(`Невідомий платіжний шлюз: ${code}`);
    return g ?? null;
  }

  /** Метадані всіх шлюзів для UI (без кредів). */
  list(): Array<{ code: string; name: string }> {
    return [...this.gateways.values()].map(g => ({ code: g.code, name: g.name }));
  }
}
