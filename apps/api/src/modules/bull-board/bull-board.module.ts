import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule as BullBoardCore } from '@bull-board/nestjs';
import { FastifyAdapter } from '@bull-board/fastify';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardAuthModule } from './bull-board-auth.module';

/**
 * D3 — bull-board admin UI для перегляду BullMQ-черг (failed-jobs, retry, delayed).
 *
 * БЕЗПЕКА (2 шари):
 *  1. Модуль монтується ЛИШЕ у non-production (register() повертає порожній модуль у prod). Це головний
 *     захист: у prod маршруту просто НЕ існує (як Swagger). Причини: (а) prod-CSP `default-src 'none'`
 *     зламав би UI bull-board (він вантажить власні JS/CSS); (б) уникаємо ризику публічного виставлення
 *     admin-панелі на проді.
 *  2. У non-prod маршрут `/api/admin/queues` захищено глобальним Fastify onRequest-хуком у main.ts
 *     (registerBullBoardGuard: bearer-JWT + OWNER/ADMIN). NestMiddleware/@UseGuards тут НЕ працюють —
 *     bull-board на Fastify монтується як plugin і обробляє свої роути повз Nest-pipeline (перевірено
 *     live: consumer.apply(middleware) не спрацьовував, роут віддавав 200 без токена).
 *
 * Пакети зафіксовано на 5.23.0 — остання лінійка bull-board, сумісна з Fastify 4 (@fastify/view@^8,
 * @fastify/static@^6). v6+/v9 тягнуть @fastify/static@^8 → вимагає Fastify 5 → FST_ERR на старті.
 *
 * 12 черг: forFeature резолвить Queue за іменем через `moduleRef.get(getQueueToken(name), {strict:false})`.
 * Queue-провайдери з registerQueue у feature-модулях scoped до тих модулів, тож реєструємо ті самі імена
 * локально тут (registerQueue ідемпотентний — BullMQ дедуплікує з'єднання за іменем; BullMQAdapter лише
 * читає стан, окремого воркера не піднімає).
 */
const QUEUE_NAMES = [
  'sms',
  'followup',
  'idempotency-purge',
  'nbu-fetch',
  'loyalty',
  'invoice-overdue',
  'reconciliation',
  'nova-poshta-polling',
  'integration-log-purge',
  'outbound-webhook',
  'checkbox',
  'payment-polling',
] as const;

@Module({})
export class BullBoardModule {
  static register(): DynamicModule {
    if (process.env.NODE_ENV === 'production') {
      return { module: BullBoardModule };
    }
    return {
      module: BullBoardModule,
      imports: [
        // @Global-модуль надає JwtService у контейнер — потрібен для registerBullBoardGuard (main.ts).
        BullBoardAuthModule,
        // Локальна реєстрація тих самих черг — щоб forFeature резолвив Queue-токен у цьому scope.
        ...QUEUE_NAMES.map(name => BullModule.registerQueue({ name })),
        BullBoardCore.forRoot({
          route: '/admin/queues',
          adapter: FastifyAdapter,
        }),
        ...QUEUE_NAMES.map(name =>
          // Cast: type-skew між @bull-board/api@5.23.0 (BaseAdapter очікує job.progress: number|object)
          // і bullmq@5.78 (JobProgress включає string). Розбіжність суто типова — BullMQAdapter лише
          // читає стан черги, рантайм коректний. Звужуємо до очікуваного forFeature-типу адаптера.
          BullBoardCore.forFeature({
            name,
            adapter: BullMQAdapter as unknown as Parameters<
              typeof BullBoardCore.forFeature
            >[0]['adapter'],
          }),
        ),
      ],
    };
  }
}
