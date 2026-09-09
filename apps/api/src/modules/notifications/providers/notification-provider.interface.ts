import type { NotificationChannel } from '@prisma/client';

/** Креди провайдера (write-only, зберігаються per-branch/channel). */
export interface ProviderCredentials {
  apiKey: string;
  senderName?: string;
}

export interface SendParams {
  channel: NotificationChannel;
  /**
   * Отримувач (locator): телефон для SMS/Viber/Telegram, email-адреса для EMAIL.
   * Тип визначається каналом.
   */
  recipient: string;
  message: string;
  /** Тема (лише EMAIL; inline SMS/Viber/Telegram ігнорують). */
  subject?: string;
  creds: ProviderCredentials;
  /**
   * ID готового шаблону в кабінеті провайдера. Потрібен для template-based каналів
   * (eSputnik Viber/Telegram через smartsend). Inline-провайдери (TurboSMS, eSputnik SMS)
   * ігнорують — текст беруть з `message`.
   */
  externalTemplateId?: string;
}

/** Результат спроби відправки — синхронний (accepted = провайдер прийняв у чергу). */
export interface SendResult {
  accepted: boolean;
  providerMessageId?: string;
  /** Причина відмови (для fallback-рішення + NotificationLog). */
  error?: string;
}

export interface VerifyResult {
  valid: boolean;
  /** Баланс рахунку у провайдера (грн/кредити), якщо API повертає. */
  balance?: number;
  /** Зареєстровані імена відправника (alpha-name), якщо API повертає. */
  senderNames?: string[];
  error?: string;
}

/**
 * Абстракція провайдера сповіщень. Один провайдер може підтримувати кілька каналів
 * (напр. TurboSMS = SMS + Viber). Registry дозволяє додавати провайдерів без зміни
 * processor/service — той лише робить `registry.get(code)`.
 */
export interface NotificationProvider {
  /** Унікальний код (зберігається у BranchSettings.smsProvider / ChannelConfig.provider). */
  readonly code: string;
  /** Людська назва для UI. */
  readonly name: string;
  /** Канали, які цей провайдер уміє відправляти. */
  readonly channels: NotificationChannel[];
  /**
   * Канали, які цей провайдер шле ТІЛЬКИ за готовим шаблоном у своєму кабінеті
   * (потребують externalTemplateId; inline-текст ігнорується). Напр. eSputnik Viber/Telegram.
   * Пусто/відсутнє → усі канали inline (текст беруть з `message`). Джерело правди
   * для того, які канали вимагають externalTemplateId — і бекенд-валідація, і UI.
   */
  readonly templateChannels?: NotificationChannel[];

  /** Відправити одне повідомлення обраним каналом. */
  send(params: SendParams): Promise<SendResult>;

  /** Перевірити креди (валідність токена + баланс) — БЕЗ відправки повідомлення. */
  verifyCredentials(creds: ProviderCredentials): Promise<VerifyResult>;
}
