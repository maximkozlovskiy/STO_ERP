/**
 * NotificationsService.sendWithConfig
 *
 * Виділено з `notifications.service.spec.ts` (був 941 рядок, 4 незалежні top-level
 * describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не змінені — інакше
 * `fullName` у test-baseline.json розійшовся б.
 *
 * Цей модуль НЕ використовує Nest DI: сервіс конструюється напряму
 * (`new NotificationsService(prisma, registry, queue)`), тож спільної фікстури не потребує.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import type { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationProviderRegistry } from './providers/provider-registry';

describe('NotificationsService.sendWithConfig', () => {
  const queueAdd = vi.fn().mockResolvedValue({});
  const queue = { add: queueAdd } as unknown as Queue;
  const prisma = {} as unknown as PrismaService;
  const registry = { get: vi.fn(), list: vi.fn() } as unknown as NotificationProviderRegistry;

  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationsService(prisma, registry, queue);
  });

  const config = {
    channels: [
      {
        channel: NotificationChannel.VIBER,
        provider: 'turbosms',
        apiKey: 'k1',
        senderName: 'STO',
        templateBody: 'Вітаємо, {{clientName}}!',
      },
      {
        channel: NotificationChannel.SMS,
        provider: 'turbosms',
        apiKey: 'k2',
        senderName: 'STO',
        templateBody: 'SMS {{clientName}}',
      },
    ],
  };

  it('рендерить шаблон per-канал і ставить ОДИН job з chainIndex=0', async () => {
    await service.sendWithConfig(
      'org-1',
      config,
      { phone: '380671112233', clientName: 'Іван' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe('send-sms');
    expect(data.chainIndex).toBe(0);
    expect(data.chain).toHaveLength(2);
    expect(data.chain[0].message).toBe('Вітаємо, Іван!');
    expect(data.chain[0].recipient).toBe('380671112233'); // recipient обрано per-channel
    expect(data.chain[1].message).toBe('SMS Іван');
    // BullMQ: retry + removeOnFail (секрет apiKey у job.data не осідає назавжди)
    expect(opts.attempts).toBe(10);
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(200);
  });

  it('порожній config.channels → job НЕ ставиться (нема сенсу)', async () => {
    await service.sendWithConfig(
      'org-1',
      { channels: [] },
      { phone: '380671112233' },
      'br-1',
      'X' as never,
    );
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('невідома змінна шаблону → порожній рядок (не "undefined")', async () => {
    await service.sendWithConfig(
      'org-1',
      { channels: [{ ...config.channels[0], templateBody: 'X {{missing}} Y' }] },
      { phone: '380671112233' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    expect(queueAdd.mock.calls[0][1].chain[0].message).toBe('X  Y');
  });

  it('EMAIL-канал без vars.email → канал пропускається (нема адресата)', async () => {
    await service.sendWithConfig(
      'org-1',
      {
        channels: [{ ...config.channels[0], channel: NotificationChannel.EMAIL, provider: 'smtp' }],
      },
      { phone: '380671112233' }, // є телефон, але немає email
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    expect(queueAdd).not.toHaveBeenCalled(); // EMAIL без email → chain порожній
  });

  it('EMAIL-канал з vars.email → recipient = email, subject відрендерено', async () => {
    await service.sendWithConfig(
      'org-1',
      {
        channels: [
          {
            channel: NotificationChannel.EMAIL,
            provider: 'smtp',
            apiKey: 'k',
            senderName: 'STO',
            templateBody: 'Тіло {{clientName}}',
            templateSubject: 'Тема {{clientName}}',
          },
        ],
      },
      { email: 'a@b.com', clientName: 'Іван' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    const step = queueAdd.mock.calls[0][1].chain[0];
    expect(step.recipient).toBe('a@b.com');
    expect(step.message).toBe('Тіло Іван');
    expect(step.subject).toBe('Тема Іван');
  });

  // ─── Змішаний ланцюг [SMS, EMAIL] — per-channel recipient selection (Bug #658) ────
  // Ключова інваріанта Email-фічі: у кожному кроці recipient — ПРАВИЛЬНОГО типу
  // (телефон у SMS-крок, email у EMAIL-крок). Витік телефону у EMAIL-крок = 500 SMTP
  // (нодмейлер `to: '38067...'` → invalid recipient) або тихий відкид.
  const mixedConfig = {
    channels: [
      {
        channel: NotificationChannel.SMS,
        provider: 'turbosms',
        apiKey: 'k-sms',
        senderName: 'STO',
        templateBody: 'SMS {{clientName}}',
      },
      {
        channel: NotificationChannel.EMAIL,
        provider: 'smtp',
        apiKey: 'k-email',
        senderName: 'STO',
        templateBody: 'Email {{clientName}}',
        templateSubject: 'Тема {{clientName}}',
      },
    ],
  };

  it('MIXED [SMS,EMAIL] + vars={phone} → EMAIL відкинуто, SMS лишається (recipient=phone)', async () => {
    await service.sendWithConfig(
      'org-1',
      mixedConfig,
      { phone: '380671112233', clientName: 'Іван' },
      'br-1',
      'WO_COMPLETED',
    );
    const chain = queueAdd.mock.calls[0][1].chain;
    expect(chain).toHaveLength(1);
    expect(chain[0].channel).toBe(NotificationChannel.SMS);
    expect(chain[0].recipient).toBe('380671112233'); // телефон у SMS
    // EMAIL з телефоном у recipient НЕ потрапив у ланцюг
    expect(chain.some((s: { channel: string }) => s.channel === NotificationChannel.EMAIL)).toBe(
      false,
    );
  });

  it('MIXED [SMS,EMAIL] + vars={email} → SMS відкинуто, EMAIL лишається (recipient=email)', async () => {
    await service.sendWithConfig(
      'org-1',
      mixedConfig,
      { email: 'client@example.com', clientName: 'Іван' },
      'br-1',
      'WO_COMPLETED',
    );
    const chain = queueAdd.mock.calls[0][1].chain;
    expect(chain).toHaveLength(1);
    expect(chain[0].channel).toBe(NotificationChannel.EMAIL);
    expect(chain[0].recipient).toBe('client@example.com'); // email у EMAIL
    expect(chain.some((s: { channel: string }) => s.channel === NotificationChannel.SMS)).toBe(
      false,
    );
  });

  it('MIXED [SMS,EMAIL] + vars={phone,email} → ОБИДВА, кожен з recipient СВОГО типу', async () => {
    await service.sendWithConfig(
      'org-1',
      mixedConfig,
      { phone: '380671112233', email: 'client@example.com', clientName: 'Іван' },
      'br-1',
      'WO_COMPLETED',
    );
    const chain = queueAdd.mock.calls[0][1].chain;
    expect(chain).toHaveLength(2);
    const sms = chain.find((s: { channel: string }) => s.channel === NotificationChannel.SMS);
    const email = chain.find((s: { channel: string }) => s.channel === NotificationChannel.EMAIL);
    // SMS-крок несе ТІЛЬКИ телефон; EMAIL-крок несе ТІЛЬКИ email (без перехрещення типів).
    expect(sms.recipient).toBe('380671112233');
    expect(sms.recipient).not.toContain('@');
    expect(email.recipient).toBe('client@example.com');
    expect(email.recipient).toContain('@');
    // subject відрендерено лише для EMAIL-кроку
    expect(email.subject).toBe('Тема Іван');
    expect(sms.subject).toBeUndefined();
  });

  it('MIXED [SMS,EMAIL] + vars={} (ні phone ні email) → порожній ланцюг, job НЕ ставиться', async () => {
    await service.sendWithConfig(
      'org-1',
      mixedConfig,
      { clientName: 'Іван' },
      'br-1',
      'WO_COMPLETED',
    );
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

/**
 * resolveConfig для EMAIL-каналу — локальний inline-шаблон з subject → templateSubject
 * прокидується у config (потім рендериться у sendWithConfig). Email — inline (не template-based),
 * тож канал придатний за наявністю локального шаблону.
 */
