/**
 * Емісія OpenAPI-документа БЕЗ запущеного сервера, БЕЗ мережі та БЕЗ живих БД/Redis.
 *
 * Навіщо (ADR-001, офлайн-незалежність): кодогенерація типів API (`openapi-typescript`)
 * не має залежати ні від інтернету, ні від підня��ого `pnpm --filter @sto/api dev`.
 * Документ будується з МЕТАДАНИХ коду (декоратори @nestjs/swagger), а не з HTTP-відповіді.
 *
 * Як це працює без БД/Redis:
 *   NestFactory.create(AppModule, { preview: true })
 * У preview-режимі Nest будує ПОВНИЙ граф модулів і зберігає метадані роутів, але НЕ
 * інстанціює провайдери → PrismaService.onModuleInit ($connect) і BullMQ-конекшени
 * не викликаються. SwaggerModule.createDocument читає саме метадані, тож документ
 * виходить повним.
 *
 * Запуск: `pnpm run gen:api-types` з кореня монорепо.
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

async function emit(): Promise<void> {
  // Дефолти, щоб env-валідація (validateEnv) не відкинула порожнє середовище розробника.
  process.env.NODE_ENV ??= 'development';

  // FastifyAdapter передаємо явно: без HTTP-драйвера Nest намагається дотягнути
  // @nestjs/platform-express (його у проєкті немає) і падає ще до побудови графа.
  // Адаптер лише створюється — listen() НЕ викликається, порт не займається.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { preview: true, logger: false, abortOnError: false },
  );

  // Дзеркалить main.ts: prefix + URI-версіонування мусять потрапити у шляхи документа,
  // інакше згенеровані ключі paths розійдуться з реальними URL (/api/v1/invoices).
  app.setGlobalPrefix('api');
  const { VersioningType } = await import('@nestjs/common');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const config = new DocumentBuilder()
    .setTitle('STO ERP API')
    .setDescription('API для системи управління автосервісом')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('sto_refresh')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  await app.close();

  // Шлях рахуємо від process.cwd() (= apps/api, бо скрипт запускається через
  // `pnpm --filter @sto/api`), а НЕ від __dirname: скрипт виконується з dist-openapi/,
  // тож відносний __dirname з'їхав би на два рівні.
  const out = resolve(process.cwd(), '../../packages/shared/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  process.stdout.write(`OpenAPI: ${paths} шляхів, ${schemas} схем -> ${out}\n`);
}

void emit().catch((err: unknown) => {
  process.stderr.write(`emit-openapi FAILED: ${String(err)}\n`);
  process.exitCode = 1;
});
