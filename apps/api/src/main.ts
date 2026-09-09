// BigInt → string serialization for JSON.stringify (Fastify serializer throws on BigInt otherwise)
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { validationExceptionFactory } from './common/pipes/validation-error.factory';
import { registerBullBoardGuard } from './modules/bull-board/bull-board.guard';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: process.env.NODE_ENV === 'development' }),
  );

  // Register Fastify plugins
  // Security headers must be set first so they apply to ALL responses (including error paths).
  // - crossOriginEmbedderPolicy disabled: avoids breaking PDF/file downloads that come from MinIO with COEP-free headers.
  // - crossOriginResourcePolicy 'cross-origin' so web app on port 3001 can fetch resources from API on 3000 in dev.
  // E1: CSP УВІМКНЕНО у production (Swagger, що вимагав inline-scripts, монтується лише у non-prod —
  //   див. нижче). API віддає JSON + file-redirect, тож жорстка default-src 'none' безпечна:
  //   немає власного HTML/скриптів для рендеру. Це defense-in-depth (головна CSP для SPA — у Caddy/web).
  //   У dev лишаємо false, щоб Swagger UI (inline scripts) завантажувався.
  const isProd = process.env.NODE_ENV === 'production';
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'none'"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.setGlobalPrefix('api');

  // D3 — bull-board (BullBoardModule) монтується як Fastify-plugin і власні роути `/api/admin/queues/*`
  // обробляє повз Nest-middleware/guards. Тож захищаємо їх глобальним Fastify onRequest-хуком (bearer-JWT
  // + OWNER/ADMIN), який спрацьовує для КОЖНОГО запиту незалежно від того, який plugin володіє роутом.
  // No-op у production (модуль там не монтується). Реєструємо ДО app.listen, у контексті DI-контейнера.
  await registerBullBoardGuard(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useLogger(app.get(PinoLogger));

  // maxAge: 86400s (24h) → browser caches CORS preflight (OPTIONS) for the
  // configured time window, so an OPTIONS request fires at most once per
  // (origin, path, method, header-set) per 24h instead of before every GET.
  // For the SPA this roughly halves the request count to the API.
  // Chrome caps maxAge at 7200s (2h) regardless of higher values — that is
  // still a major improvement over no cache at all.
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3001',
    credentials: true,
    maxAge: 86400,
  });

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('STO ERP API')
      .setDescription('API для системи управління автосервісом')
      .setVersion('0.1.0')
      .addBearerAuth()
      .addCookieAuth('sto_refresh')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Graceful shutdown: при docker stop / рестарті СТО-ПК (SIGTERM) NestJS запускає
  // onModuleDestroy-хуки → Prisma закриває конекшени, BullMQ-воркери завершують
  // поточні джоби й від'єднуються чисто. Без цього in-flight запити/джоби обриваються —
  // критично для офлайн-черг (ПРРО/SMS з retry) на ПК, що часто вимикають.
  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Bootstrap');
  logger.log(`API запущено на порту ${port}`);
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`Swagger: http://localhost:${port}/api/docs`);
  }
}

void bootstrap();
