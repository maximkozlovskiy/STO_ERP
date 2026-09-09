import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { NotificationProviderRegistry } from './provider-registry';
import { TurboSmsProvider } from './turbosms.provider';
import { EsputnikProvider } from './esputnik.provider';
import { EmailProvider } from './email.provider';

/**
 * Реєстр провайдерів — джерело правди для UI (NotificationProvidersPanel читає
 * `templateChannels` щоб показати поле «ID шаблону») І для бек-валідації
 * (resolveConfig / upsertBranchChannel гейтять externalTemplateId по templateChannels).
 * Ці тести фіксують контракт `list()`: реальні провайдери мають коректні
 * channels/templateChannels; регрес у мапінгу (втрата `?? []`, зникнення поля) → червоний.
 */
describe('NotificationProviderRegistry', () => {
  let registry: NotificationProviderRegistry;

  beforeEach(() => {
    registry = new NotificationProviderRegistry([
      new TurboSmsProvider(),
      new EsputnikProvider(),
      new EmailProvider(),
    ]);
  });

  it('get() повертає зареєстрований провайдер за кодом', () => {
    expect(registry.get('turbosms')?.code).toBe('turbosms');
    expect(registry.get('esputnik')?.code).toBe('esputnik');
    expect(registry.get('smtp')?.code).toBe('smtp');
  });

  it('get() невідомий код → null (не кидає)', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('list() віддає всіх провайдерів з метаданими', () => {
    const list = registry.list();
    expect(list.map(p => p.code).sort()).toEqual(['esputnik', 'smtp', 'turbosms']);
  });

  it('list(): Email (smtp) — channels=[EMAIL], templateChannels порожній (inline)', () => {
    const smtp = registry.list().find(p => p.code === 'smtp')!;
    expect(smtp.channels).toEqual([NotificationChannel.EMAIL]);
    expect(smtp.templateChannels).toEqual([]);
  });

  it('list(): eSputnik templateChannels = [VIBER, TELEGRAM], SMS НЕ входить (inline)', () => {
    const esputnik = registry.list().find(p => p.code === 'esputnik')!;
    expect(esputnik.channels).toEqual(['SMS', 'VIBER', 'TELEGRAM']);
    expect(esputnik.templateChannels).toEqual([
      NotificationChannel.VIBER,
      NotificationChannel.TELEGRAM,
    ]);
    // Ключова інваріанта: SMS inline → НЕ у templateChannels (інакше UI показав би поле
    // «ID шаблону» для SMS, а send надіслав би порожній inline-текст).
    expect(esputnik.templateChannels).not.toContain(NotificationChannel.SMS);
  });

  it('list(): TurboSMS templateChannels порожній (усі канали inline)', () => {
    const turbosms = registry.list().find(p => p.code === 'turbosms')!;
    expect(turbosms.channels).toEqual(['SMS', 'VIBER']);
    // TurboSMS не має templateChannels → мапінг `?? []` дає порожній масив (не undefined),
    // щоб UI/валідація трактували всі канали як inline.
    expect(turbosms.templateChannels).toEqual([]);
  });

  it('list(): templateChannels завжди масив (навіть коли провайдер поле не оголосив)', () => {
    for (const p of registry.list()) {
      expect(Array.isArray(p.templateChannels)).toBe(true);
    }
  });
});
