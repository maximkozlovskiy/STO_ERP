import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  type NotificationProvider,
  NOTIFICATION_PROVIDERS,
} from './notification-provider.interface';

/**
 * Реєстр провайдерів сповіщень. Провайдери інжектяться масивом через multi-provider DI-токен
 * NOTIFICATION_PROVIDERS — додати нового = зареєструвати impl у notifications.module
 * (`{ provide: NOTIFICATION_PROVIDERS, useExisting: <Impl>, multi: true }`), сам реєстр НЕ чіпається
 * (Open/Closed + DIP). `sms.processor` та settings-endpoints звертаються через `get(code)` / `list()`.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly logger = new Logger(NotificationProviderRegistry.name);
  private readonly providers = new Map<string, NotificationProvider>();

  constructor(@Inject(NOTIFICATION_PROVIDERS) providers: NotificationProvider[]) {
    for (const p of providers) this.providers.set(p.code, p);
  }

  /** Провайдер за кодом або null (невідомий код — логуємо, не кидаємо). */
  get(code: string): NotificationProvider | null {
    const p = this.providers.get(code);
    if (!p) this.logger.warn(`Невідомий провайдер сповіщень: ${code}`);
    return p ?? null;
  }

  /** Метадані всіх провайдерів для UI (без кредів). */
  list(): Array<{ code: string; name: string; channels: string[]; templateChannels: string[] }> {
    return [...this.providers.values()].map(p => ({
      code: p.code,
      name: p.name,
      channels: p.channels,
      // Канали, що потребують externalTemplateId — UI показує поле «ID шаблону» саме для них.
      templateChannels: p.templateChannels ?? [],
    }));
  }
}
