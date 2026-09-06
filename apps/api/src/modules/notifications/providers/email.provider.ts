import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import type {
  NotificationProvider,
  ProviderCredentials,
  SendParams,
  SendResult,
  VerifyResult,
} from './notification-provider.interface';

const SMTP_TIMEOUT_MS = 10_000;

/** SMTP-конфіг, серіалізований JSON-ом у creds.apiKey (шифрується at-rest як і будь-який apiKey). */
interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean; // true = TLS (465); false = STARTTLS/plain (587/25)
  user: string;
  pass: string;
}

/**
 * Email-канал через SMTP (nodemailer). Універсальний: будь-яка пошта (Gmail/Ukr.net/власний
 * сервер). Креди зберігаються JSON-ом у apiKey `{host,port,secure,user,pass}` (0 нових колонок,
 * ціле поле шифрується Phase 4). senderName = From (адреса/назва відправника).
 *
 * Офлайн-інваріант: SMTP timeout 10s (connection/greeting/socket), щоб воркер не висів без мережі.
 * Помилка → accepted:false (не throw) — як інші провайдери; BullMQ-retry на рівні черги.
 */
@Injectable()
export class EmailProvider implements NotificationProvider {
  readonly code = 'smtp';
  readonly name = 'Email (SMTP)';
  readonly channels: NotificationChannel[] = [NotificationChannel.EMAIL];
  // Email — inline (тема+тіло з наших NotificationTemplate). Не template-based провайдера.
  readonly templateChannels: NotificationChannel[] = [];

  private readonly logger = new Logger(EmailProvider.name);

  async send(params: SendParams): Promise<SendResult> {
    const { channel, recipient, message, subject, creds } = params;
    if (channel !== NotificationChannel.EMAIL) {
      return { accepted: false, error: `Email: канал ${channel} не підтримується` };
    }
    const cfg = this.parseConfig(creds.apiKey);
    if (!cfg) return { accepted: false, error: 'Email: некоректний SMTP-конфіг' };

    // Ресурс-безпека: transport тримає TCP-сокет/пул → close() ОБОВʼЯЗКОВО у finally.
    // Без нього кинутий sendMail (таймаут/auth-фейл) лишав би сокет висіти → накопичення
    // з кожною невдалою відправкою (concurrency=3 × attempts=10 → десятки leaked-сокетів).
    const transport = this.createTransport(cfg);
    try {
      const info = await transport.sendMail({
        from: creds.senderName ?? cfg.user,
        to: recipient,
        subject: subject ?? '',
        text: message,
      });
      return { accepted: true, providerMessageId: info.messageId };
    } catch (e) {
      return { accepted: false, error: e instanceof Error ? e.message : 'Email: помилка SMTP' };
    } finally {
      transport.close();
    }
  }

  async verifyCredentials(creds: ProviderCredentials): Promise<VerifyResult> {
    const cfg = this.parseConfig(creds.apiKey);
    if (!cfg) return { valid: false, error: 'Некоректний SMTP-конфіг' };
    // Ресурс-безпека: close() у finally навіть коли verify() кинув (таймаут/auth-фейл).
    const transport = this.createTransport(cfg);
    try {
      // verify() = SMTP-хендшейк + auth без відправки листа. balance для SMTP не існує.
      await transport.verify();
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка SMTP-зʼєднання' };
    } finally {
      transport.close();
    }
  }

  /** Парсить SMTP-конфіг з JSON apiKey. Толерантно: невалідний JSON/поля → null. */
  private parseConfig(apiKey: string): SmtpConfig | null {
    try {
      const raw = JSON.parse(apiKey) as Partial<SmtpConfig>;
      if (!raw.host || !raw.user || !raw.pass) return null;
      return {
        host: String(raw.host),
        port: Number(raw.port) || 587,
        secure: Boolean(raw.secure),
        user: String(raw.user),
        pass: String(raw.pass),
      };
    } catch {
      return null;
    }
  }

  private createTransport(cfg: SmtpConfig) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      // Офлайн-інваріант: жорсткі таймаути, щоб воркер не висів без мережі.
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }
}
