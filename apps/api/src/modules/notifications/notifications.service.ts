import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationChannel, NotificationEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProviderRegistry } from './providers/provider-registry';

export type NotificationEvent = NotificationEventType;

/** Канали, отримувач яких — email (а не телефон). Для них locator береться з payload.email. */
const EMAIL_CHANNELS = new Set<NotificationChannel>([NotificationChannel.EMAIL]);

/** Один канал у fallback-ланцюзі: провайдер + креди + вже відрендерений текст + отримувач. */
export interface ChannelStep {
  channel: NotificationChannel;
  provider: string;
  apiKey: string;
  senderName: string;
  message: string;
  /** Тема (лише EMAIL); відрендерена. */
  subject?: string;
  /** Отримувач цього каналу: телефон (SMS/Viber/TG) або email (EMAIL). */
  recipient: string;
  /** ID шаблону провайдера (eSputnik Viber/Telegram); null для inline-каналів. */
  externalTemplateId?: string;
}

/**
 * Впорядкований fallback-ланцюг каналів (за пріоритетом) для однієї події+філії.
 * Спільний для батчу отримувачів (текст рендериться per-recipient у sendWithConfig).
 */
export interface NotificationConfig {
  /** Впорядковані enabled-канали (priority ASC). templateBody — шаблон ДО рендеру. */
  channels: {
    channel: NotificationChannel;
    provider: string;
    apiKey: string;
    senderName: string;
    /** Локальний inline-шаблон (для SMS/inline). Порожній для external-template каналів. */
    templateBody: string;
    /** Тема-шаблон (лише EMAIL) ДО рендеру. */
    templateSubject?: string;
    /** ID шаблону провайдера (eSputnik Viber/Telegram); null для inline-каналів. */
    externalTemplateId?: string;
  }[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: NotificationProviderRegistry,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async send(
    orgId: string,
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const branchId = typeof payload.branchId === 'string' ? payload.branchId : undefined;
    if (!branchId) {
      this.logger.debug(`branchId не вказано для org=${orgId}, event=${event} — SMS пропущено`);
      return;
    }
    // Отримувач залежить від каналу: телефон (SMS/Viber/TG) або email (EMAIL).
    // Бейлимо лише якщо немає ЖОДНОГО адресата — sendWithConfig обере locator per-channel.
    const phone = typeof payload.phone === 'string' ? payload.phone : undefined;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (!phone && !email) return;

    const config = await this.resolveConfig(orgId, branchId, event);
    if (!config) return;

    await this.sendWithConfig(orgId, config, payload, branchId, event);
  }

  /**
   * Побудова fallback-ланцюга каналів для батчу отримувачів (спільний orgId+branchId+event).
   * Повертає null якщо жоден канал не налаштований/немає шаблону — батч аборт.
   *
   * Джерело каналів (з fallback на legacy):
   *  1) NotificationChannelConfig — впорядковані enabled-канали (priority ASC). Кожному
   *     каналу підбирається активний NotificationTemplate цього channel; без шаблону канал
   *     тихо пропускається (fallback перескочить на наступний).
   *  2) Legacy: якщо конфіг-рядків немає — читаємо BranchSettings.sms* як одноканальний
   *     SMS-ланцюг (зворотна сумісність до data-migration).
   *
   * Perf: follow-up-процесор шле до 2000 отримувачів/org → читаємо конфіг+шаблони ОДИН раз
   * на батч, не per-recipient.
   */
  async resolveConfig(
    orgId: string,
    branchId: string,
    event: NotificationEvent,
  ): Promise<NotificationConfig | null> {
    const channelConfigs = await this.prisma.notificationChannelConfig.findMany({
      where: { orgId, branchId, enabled: true, deletedAt: null, apiKey: { not: null } },
      orderBy: { priority: 'asc' },
      select: {
        channel: true,
        provider: true,
        apiKey: true,
        senderName: true,
        externalTemplateId: true,
      },
      take: 20, // bounded by @@unique([branchId,channel]) — take як defence-in-depth (§1)
    });

    if (channelConfigs.length > 0) {
      // Шаблони для всіх задіяних каналів — одним запитом.
      const wantedChannels = [...new Set(channelConfigs.map(c => c.channel))];
      const templates = await this.prisma.notificationTemplate.findMany({
        where: { orgId, eventType: event, channel: { in: wantedChannels }, isActive: true },
        select: { channel: true, body: true, subject: true }, // subject — для EMAIL
        take: 20, // bounded by @@unique([orgId,eventType,channel]) — take як defence-in-depth (§1)
      });
      const byChannel = new Map(templates.map(t => [t.channel, t]));

      // Канал придатний якщо має локальний inline-шаблон АБО (externalTemplateId І провайдер
      // реально шле цей канал через шаблон). Без перевірки провайдера inline-канал (SMS/TurboSMS
      // Viber) з випадково записаним externalTemplateId надіслав би ПОРОЖНІЙ inline-текст.
      const channels = channelConfigs
        .filter(c => {
          if (byChannel.has(c.channel)) return true; // локальний inline-шаблон є
          if (!c.externalTemplateId) return false; // немає жодного джерела тексту
          // externalTemplateId є — але зараховуємо лише якщо провайдер шле канал через шаблон.
          return this.registry.get(c.provider)?.templateChannels?.includes(c.channel) ?? false;
        })
        .map(c => ({
          channel: c.channel,
          provider: c.provider,
          apiKey: c.apiKey as string, // гарантовано not-null через where
          senderName: c.senderName ?? 'STO ERP',
          templateBody: byChannel.get(c.channel)?.body ?? '', // порожній для external-template
          templateSubject: byChannel.get(c.channel)?.subject ?? undefined,
          externalTemplateId: c.externalTemplateId ?? undefined,
        }));

      if (channels.length === 0) {
        this.logger.debug(`Жодного каналу з шаблоном для org=${orgId}, event=${event}`);
        return null;
      }
      return { channels };
    }

    // Legacy fallback — одноканальний SMS із BranchSettings.
    const [branchSettings, template] = await Promise.all([
      this.prisma.branchSettings.findFirst({
        where: { branchId, orgId },
        select: { smsEnabled: true, smsApiKey: true, smsProvider: true, smsSenderName: true },
      }),
      this.prisma.notificationTemplate.findFirst({
        where: { orgId, eventType: event, channel: 'SMS', isActive: true },
        select: { body: true },
      }),
    ]);

    if (!branchSettings?.smsEnabled || !branchSettings?.smsApiKey) {
      this.logger.debug(`SMS не налаштовано для org=${orgId}, event=${event}`);
      return null;
    }
    if (!template) {
      this.logger.debug(`Шаблон сповіщення ${event}/SMS не знайдено для org=${orgId}`);
      return null;
    }

    return {
      channels: [
        {
          channel: NotificationChannel.SMS,
          provider: branchSettings.smsProvider ?? 'turbosms',
          apiKey: branchSettings.smsApiKey,
          senderName: branchSettings.smsSenderName ?? 'STO ERP',
          templateBody: template.body,
        },
      ],
    };
  }

  /**
   * Ставить у чергу fallback-ланцюг для одного отримувача (без DB-читань).
   * Отримувач обирається per-channel з `vars`: телефон (SMS/Viber/TG) або email (EMAIL).
   * Канал без відповідного адресата пропускається (напр. EMAIL без vars.email). Текст і тему
   * рендеримо per-channel. Processor іде ланцюгом: chain[i] accepted → STOP; reject → наступний.
   */
  async sendWithConfig(
    orgId: string,
    config: NotificationConfig,
    vars: Record<string, unknown>,
    branchId?: string,
    event?: NotificationEvent,
  ): Promise<void> {
    const phone = typeof vars.phone === 'string' ? vars.phone : undefined;
    const email = typeof vars.email === 'string' ? vars.email : undefined;

    const chain: ChannelStep[] = config.channels
      .map((c): ChannelStep | null => {
        const recipient = EMAIL_CHANNELS.has(c.channel) ? email : phone;
        if (!recipient) return null; // немає адресата для цього каналу → пропуск
        return {
          channel: c.channel,
          provider: c.provider,
          apiKey: c.apiKey,
          senderName: c.senderName,
          message: this.renderTemplate(c.templateBody, vars),
          subject: c.templateSubject ? this.renderTemplate(c.templateSubject, vars) : undefined,
          recipient,
          externalTemplateId: c.externalTemplateId,
        };
      })
      .filter((s): s is ChannelStep => s !== null);
    if (chain.length === 0) return;

    await this.smsQueue.add(
      'send-sms',
      { orgId, branchId, event, chain, chainIndex: 0 },
      {
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        // §2.4: job.data.chain містить apiKey у відкритому вигляді. Без removeOnFail
        // невдалі jobs осідають у Redis назавжди → секрет живе безстроково + ріст пам'яті.
        // Тримаємо обмежене вікно для діагностики (як webhooks queue).
        removeOnFail: 200,
      },
    );
  }

  async findTemplates(orgId: string) {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: { orgId },
      orderBy: [{ eventType: 'asc' }, { channel: 'asc' }],
      take: 100,
    });
    return rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }));
  }

  async updateTemplate(
    orgId: string,
    id: string,
    dto: { body: string; subject?: string; isActive: boolean },
  ) {
    // sto-optimize: narrow existence guard — full row not needed, update returns it.
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!template) throw new NotFoundException('Шаблон не знайдено');
    const updated = await this.prisma.notificationTemplate.update({
      where: { id, orgId },
      data: { body: dto.body, subject: dto.subject, isActive: dto.isActive },
    });
    return { ...updated, syncVersion: Number(updated.syncVersion) };
  }

  // ─── Провайдери та канали (Phase 3) ──────────────────────────────────────

  /** Метадані зареєстрованих провайдерів (без кредів). */
  listProviders() {
    return this.registry.list();
  }

  /**
   * Перевірка кредів провайдера: валідність токена + баланс. Тест-повідомлення НЕ шлемо.
   * apiKey приходить з body (write-only) — ніколи не логується й не повертається назад.
   */
  async verifyProvider(code: string, apiKey: string, senderName?: string) {
    const impl = this.registry.get(code);
    if (!impl) throw new NotFoundException('Провайдер не знайдено');
    return impl.verifyCredentials({ apiKey, senderName });
  }

  /**
   * Канали філії (для UI-панелі). apiKey НІКОЛИ не повертається — лише прапорець hasApiKey.
   */
  async getBranchChannels(orgId: string, branchId: string) {
    const rows = await this.prisma.notificationChannelConfig.findMany({
      where: { orgId, branchId, deletedAt: null },
      orderBy: { priority: 'asc' },
      select: {
        id: true,
        channel: true,
        provider: true,
        enabled: true,
        priority: true,
        apiKey: true,
        senderName: true,
        externalTemplateId: true, // не секрет — віддаємо у GET
        updatedAt: true,
      },
      take: 20,
    });
    // Мапимо apiKey → hasApiKey (write-only секрет не виходить за межі бекенду).
    return rows.map(({ apiKey, ...r }) => ({ ...r, hasApiKey: apiKey != null && apiKey !== '' }));
  }

  /**
   * Upsert конфігу каналу філії. apiKey оновлюється лише якщо переданий (write-only:
   * порожній/undefined → зберігаємо наявний ключ). Провайдер має підтримувати канал.
   */
  async upsertBranchChannel(
    orgId: string,
    branchId: string,
    dto: {
      channel: NotificationChannel;
      provider: string;
      enabled?: boolean;
      priority?: number;
      apiKey?: string;
      senderName?: string;
      externalTemplateId?: string;
    },
  ) {
    // Валідація: філія в межах org.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    // Валідація: провайдер існує і підтримує цей канал.
    const impl = this.registry.get(dto.provider);
    if (!impl) throw new BadRequestException('Невідомий провайдер');
    if (!impl.channels.includes(dto.channel)) {
      throw new BadRequestException(`Провайдер ${dto.provider} не підтримує канал ${dto.channel}`);
    }

    // externalTemplateId має сенс ЛИШЕ для template-based каналів провайдера (Viber/Telegram
    // eSputnik). Для inline-каналів (SMS усіх провайдерів, TurboSMS Viber) записати шаблон →
    // resolveConfig визнав би канал придатним, а inline-провайдер надіслав би ПОРОЖНІЙ текст.
    // Тож на inline-каналах примусово скидаємо externalTemplateId у null (defence-in-depth:
    // фронт уже не показує поле, але прямий API-виклик обходить UI).
    const isTemplateChannel = impl.templateChannels?.includes(dto.channel) ?? false;
    const externalTemplateId = isTemplateChannel ? (dto.externalTemplateId ?? null) : null;

    // apiKey: оновлюємо лише коли надіслано непорожнє значення (write-only).
    const apiKeyPatch = dto.apiKey != null && dto.apiKey !== '' ? { apiKey: dto.apiKey } : {};

    // Atomic upsert по @@unique([branchId, channel]) — уникає findFirst-then-create гонки
    // (два одночасні PATCH на той самий (branchId,channel) → інакше P2002/500 або дубль).
    // branchId вже провалідовано як org-scoped вище, тож unique-ключ безпечний без orgId.
    const row = await this.prisma.notificationChannelConfig.upsert({
      where: { branchId_channel: { branchId, channel: dto.channel } },
      update: {
        provider: dto.provider,
        enabled: dto.enabled,
        priority: dto.priority,
        senderName: dto.senderName,
        externalTemplateId,
        deletedAt: null, // reactivate якщо був soft-deleted
        ...apiKeyPatch,
      },
      create: {
        orgId,
        branchId,
        channel: dto.channel,
        provider: dto.provider,
        enabled: dto.enabled ?? true,
        priority: dto.priority ?? 0,
        senderName: dto.senderName,
        externalTemplateId,
        ...apiKeyPatch,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /**
   * Ексклюзивна активація провайдера для філії: канали цього провайдера → enabled=true,
   * канали ВСІХ інших провайдерів → enabled=false. Активним може бути лише один провайдер
   * (усі його канали лишаються у fallback-ланцюзі за пріоритетом). Атомарно через $transaction.
   */
  async activateProvider(orgId: string, branchId: string, providerCode: string) {
    // Провайдер має існувати у реєстрі.
    if (!this.registry.get(providerCode)) {
      throw new BadRequestException('Невідомий провайдер');
    }
    // Філія в межах org.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    await this.prisma.$transaction([
      // Вимкнути канали всіх інших провайдерів.
      this.prisma.notificationChannelConfig.updateMany({
        where: { orgId, branchId, deletedAt: null, provider: { not: providerCode } },
        data: { enabled: false },
      }),
      // Увімкнути канали активного провайдера.
      this.prisma.notificationChannelConfig.updateMany({
        where: { orgId, branchId, deletedAt: null, provider: providerCode },
        data: { enabled: true },
      }),
    ]);
    return { activeProvider: providerCode };
  }

  private renderTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }
}
