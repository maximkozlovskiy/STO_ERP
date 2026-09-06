import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Шифрування секретів at-rest (AES-256-GCM). Закриває H-2: apiKey/ПРРО-ключі більше
 * не зберігаються у Postgres у відкритому вигляді.
 *
 * Формат зашифрованого значення (рядок):  enc:v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
 * - iv 12 байт (GCM-стандарт), tag 16 байт (аутентифікація).
 * - decrypt ТОЛЕРАНТНИЙ: значення без префікса `enc:v1:` повертається як є (legacy plaintext) →
 *   zero-downtime rollout, lazy re-encrypt при наступному збереженні.
 *
 * Ключ: process.env.NOTIFICATION_ENC_KEY (генерується інсталятором один раз, ніколи не
 * регенерується — інакше наявний ciphertext стане недешифровним). Приймаємо base64/hex/utf8:
 * нормалізуємо у рівно 32 байти через SHA-256 (стабільно для будь-якої довжини вводу).
 */
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('NOTIFICATION_ENC_KEY');
    if (!raw || raw.trim() === '') {
      // Offline-first: не валимо застосунок. Без ключа шифрування вимкнено — секрети
      // читаються/пишуться як plaintext (як до Phase 4). Гучне попередження для продакшну.
      this.logger.warn(
        'NOTIFICATION_ENC_KEY не задано — шифрування секретів ВИМКНЕНО (plaintext at-rest). ' +
          'Для продакшну задайте ключ у .env.',
      );
      return;
    }
    // Нормалізуємо будь-який ввід у детермінований 32-байтовий ключ.
    this.key = createHash('sha256').update(raw, 'utf8').digest();
  }

  /** true якщо ключ налаштовано (шифрування активне). */
  get enabled(): boolean {
    return this.key !== null;
  }

  /** Чи значення вже зашифроване нашим форматом. */
  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  /**
   * Шифрує plaintext. Якщо ключа немає — повертає як є (plaintext, Phase-4-off режим).
   * Ідемпотентно: вже зашифроване значення повертається без змін (захист від подвійного
   * шифрування, критично при lazy re-encrypt + upsert).
   */
  encrypt(plaintext: string): string {
    if (!this.key) return plaintext;
    if (this.isEncrypted(plaintext)) return plaintext;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /**
   * Дешифрує значення. ТОЛЕРАНТНО:
   *  - без префікса `enc:v1:` → повертає як є (legacy plaintext, backward-compat);
   *  - з префіксом, але ключа немає / формат битий / tag не збігається → кидає (не мовчазний фейл,
   *    щоб не віддати «сміття» як валідний ключ і не надіслати SMS з невірним токеном тихо).
   */
  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value; // legacy plaintext
    if (!this.key) {
      throw new Error('Значення зашифроване, але NOTIFICATION_ENC_KEY не задано');
    }
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Невірний формат зашифрованого значення');
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /** Дешифрує nullable-значення (null/undefined → як є). */
  decryptNullable(value: string | null | undefined): string | null | undefined {
    if (value == null) return value;
    return this.decrypt(value);
  }
}
