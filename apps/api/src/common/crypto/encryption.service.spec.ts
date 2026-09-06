import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

/**
 * EncryptionService (AES-256-GCM) — round-trip, ідемпотентність, толерантний decrypt
 * (legacy plaintext), поведінка без ключа, tamper-детекція (GCM tag).
 */
function makeService(key: string | undefined): EncryptionService {
  const config = {
    get: (k: string) => (k === 'NOTIFICATION_ENC_KEY' ? key : undefined),
  } as ConfigService;
  const svc = new EncryptionService(config);
  svc.onModuleInit();
  return svc;
}

describe('EncryptionService (ключ заданий)', () => {
  let svc: EncryptionService;
  beforeEach(() => {
    svc = makeService('dev_notification_enc_key_change_in_prod');
  });

  it('enabled=true коли ключ заданий', () => {
    expect(svc.enabled).toBe(true);
  });

  it('encrypt→decrypt round-trip повертає оригінал', () => {
    const secret = 'turbosms-token-абв-123';
    const enc = svc.encrypt(secret);
    expect(enc).not.toBe(secret);
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(svc.decrypt(enc)).toBe(secret);
  });

  it('encrypt недетермінований (різні iv → різний ciphertext)', () => {
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same');
    expect(svc.decrypt(b)).toBe('same');
  });

  it('encrypt ідемпотентний — вже зашифроване не шифрується вдруге', () => {
    const once = svc.encrypt('key');
    const twice = svc.encrypt(once);
    expect(twice).toBe(once);
    expect(svc.decrypt(twice)).toBe('key');
  });

  it('decrypt толерантний до legacy plaintext (без префікса → як є)', () => {
    expect(svc.decrypt('legacy-plaintext-key')).toBe('legacy-plaintext-key');
  });

  it('decryptNullable: null/undefined проходять як є', () => {
    expect(svc.decryptNullable(null)).toBeNull();
    expect(svc.decryptNullable(undefined)).toBeUndefined();
    expect(svc.decryptNullable(svc.encrypt('x'))).toBe('x');
  });

  it('tamper-детекція: змінений ciphertext → decrypt кидає (GCM tag)', () => {
    const enc = svc.encrypt('secret');
    // Псуємо останній символ base64-ciphertext.
    const tampered = enc.slice(0, -1) + (enc.endsWith('A') ? 'B' : 'A');
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('битий формат (не 3 частини) → кидає', () => {
    expect(() => svc.decrypt('enc:v1:onlyonepart')).toThrow('Невірний формат');
  });
});

describe('EncryptionService (ключ НЕ заданий)', () => {
  it('enabled=false; encrypt=passthrough; decrypt plaintext OK', () => {
    const svc = makeService(undefined);
    expect(svc.enabled).toBe(false);
    expect(svc.encrypt('secret')).toBe('secret'); // без ключа — plaintext
    expect(svc.decrypt('plaintext')).toBe('plaintext');
  });

  it('decrypt зашифрованого значення без ключа → кидає (не мовчазний фейл)', () => {
    const withKey = makeService('some-key');
    const enc = withKey.encrypt('secret');
    const noKey = makeService(undefined);
    expect(() => noKey.decrypt(enc)).toThrow('NOTIFICATION_ENC_KEY');
  });
});
