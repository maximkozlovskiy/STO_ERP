import { Injectable, Logger } from '@nestjs/common';
import type { NotificationProvider } from './notification-provider.interface';
import { TurboSmsProvider } from './turbosms.provider';
import { EsputnikProvider } from './esputnik.provider';

/**
 * Реєстр провайдерів сповіщень. Додати нового провайдера = додати impl у конструктор.
 * `sms.processor` та settings-endpoints звертаються сюди через `get(code)` / `list()`,
 * тож жоден switch по коду провайдера більше не потрібен.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly logger = new Logger(NotificationProviderRegistry.name);
  private readonly providers = new Map<string, NotificationProvider>();

  constructor(turbosms: TurboSmsProvider, esputnik: EsputnikProvider) {
    this.register(turbosms);
    this.register(esputnik);
  }

  private register(p: NotificationProvider): void {
    this.providers.set(p.code, p);
  }

  /** Провайдер за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): NotificationProvider | null {
    const p = this.providers.get(code);
    if (!p) this.logger.warn(`Невідомий провайдер сповіщень: ${code}`);
    return p ?? null;
  }

  /** Метадані всіх провайдерів для UI (без кредів). */
  list(): Array<{ code: string; name: string; channels: string[] }> {
    return [...this.providers.values()].map(p => ({
      code: p.code,
      name: p.name,
      channels: p.channels,
    }));
  }
}
