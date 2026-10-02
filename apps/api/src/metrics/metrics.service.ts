import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Registry, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Локальні метрики у форматі Prometheus.
 *
 * НАВІЩО (аудит 2026-10). Прод — коробка на машині клієнта (ADR-003), доступу до неї
 * немає. На скаргу «система гальмує» не було ЖОДНИХ даних: логи (pino) показують події,
 * але не тривалості й не стан черг. Health-endpoint каже лише «ok/error».
 *
 * ЧОМУ prom-client, А НЕ OpenTelemetry. ADR-001 вимагає повної офлайн-незалежності:
 * жодних зовнішніх збирачів, жодних мережевих викликів. prom-client тримає метрики
 * В ПАМ'ЯТІ процесу й віддає їх текстом на запит — цього достатньо, щоб відкрити
 * /metrics на місці й побачити зріз. Повний OTel-стек (колектор, експортер, backend)
 * для on-prem без інтернету — зайва складність.
 *
 * ЩО МІРЯЄМО — лише те, що відповідає на реальні питання підтримки:
 *  · тривалість HTTP-запитів за маршрутом → «що саме гальмує»;
 *  · глибина черг → «чи застрягли SMS/ПРРО/синхронізація» (ключове для офлайн-моделі:
 *    черга росте, коли інтернету немає, і це НОРМА — але треба бачити, наскільки);
 *  · dead-letter → «скільки задач остаточно впало»;
 *  · процес (CPU/RSS/event-loop) через collectDefaultMetrics → «чи впирається в ресурси»
 *    у контейнері з mem_limit: 1g.
 *
 * Чого НЕ міряємо: бізнес-показники (виручка, кількість нарядів). Вони вже є у звітах і
 * у метриках виглядали б як дублювання з гіршою точністю.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  /** Тривалість HTTP-запиту. Бакети — під on-prem реальність, не під мікросервіси. */
  readonly httpDuration = new Histogram({
    name: 'sto_http_request_duration_seconds',
    help: 'Тривалість обробки HTTP-запиту',
    labelNames: ['method', 'route', 'status'] as const,
    // 5ms…10s: нижня межа — кеш/health, верхня — важкі звіти й OCR-імпорт накладної.
    buckets: [0.005, 0.025, 0.1, 0.3, 1, 3, 10],
    registers: [this.registry],
  });

  /** Глибина черги за станом. Для офлайн-моделі головна метрика. */
  readonly queueDepth = new Gauge({
    name: 'sto_queue_jobs',
    help: 'Кількість задач у черзі за станом',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'sto_' });
  }

  /**
   * Оновлює gauge-метрики перед віддачею. Gauge — це «зріз зараз», тож збирати їх
   * фоновим таймером означало б тримати дані застарілими між тіками; дешевше запитати
   * у момент скрейпу (кілька Redis-команд).
   */
  async refresh(): Promise<void> {
    const counts = await this.smsQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, count] of Object.entries(counts)) {
      this.queueDepth.set({ queue: 'sms', state }, count ?? 0);
    }

    // Dead-letter — окремо від черги: це задачі, що ВИЧЕРПАЛИ всі спроби, тобто
    // вимагають ручного розбору. Їхня кількість не спадає сама.
    const dlqCount = await this.prisma.deadLetterJob.count({ where: { resolvedAt: null } });
    this.queueDepth.set({ queue: 'dead-letter', state: 'unresolved' }, dlqCount);
  }

  async render(): Promise<string> {
    await this.refresh();
    return this.registry.metrics();
  }

  onModuleDestroy(): void {
    // Інакше collectDefaultMetrics тримає інтервал і процес не завершується на SIGTERM —
    // та сама пастка, що з OCR-воркером.
    this.registry.clear();
  }
}
