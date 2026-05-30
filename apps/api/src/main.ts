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

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: process.env.NODE_ENV === 'development' }),
  );

  // Register Fastify plugins
  // Bug #135: security headers must be set first so they apply to ALL responses (including error paths).
  // - contentSecurityPolicy disabled: Swagger UI uses inline scripts and would otherwise refuse to load.
  // - crossOriginEmbedderPolicy disabled: avoids breaking PDF/file downloads that come from MinIO with COEP-free headers.
  // - crossOriginResourcePolicy 'cross-origin' so web app on port 3001 can fetch resources from API on 3000 in dev.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.setGlobalPrefix('api');

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

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Bootstrap');
  logger.log(`API запущено на порту ${port}`);
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`Swagger: http://localhost:${port}/api/docs`);
  }
}

bootstrap();
