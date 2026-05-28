import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;
const enabled = !!dsn; // enabled in any env when DSN is set

Sentry.init({
  dsn,
  enabled,
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.npm_package_version,

  // 100% у dev для повного трасування, 10% у prod щоб не перевантажувати квоту
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Не надсилати 4xx (400/401/403/404) — очікувана поведінка, не баги.
  // Фільтрація відбувається в HttpExceptionFilter, але додаткова перевірка тут
  // захищає від будь-яких шляхів обходу.
  beforeSend(event) {
    const status = (event.contexts?.['response'] as { status_code?: number } | undefined)?.status_code;
    if (status !== undefined && status < 500) return null;
    return event;
  },
});
