'use client';

import * as Sentry from '@sentry/browser';

let initialized = false;

export function initSentry() {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const enabled = process.env.NODE_ENV === 'production' && !!dsn;

  Sentry.init({
    dsn,
    enabled,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: enabled ? 0.1 : 0,

    // Ігнорувати очікувані клієнтські помилки та browser extension noise
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // Chrome extensions
      'chrome-extension://',
      'moz-extension://',
      // Next.js dev overlay
      'Failed to fetch dynamically imported module',
    ],

    beforeSend(event) {
      // Не надсилати помилки з browser extensions
      const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
      const fromExtension = frames.some(
        (f) => f.filename?.includes('extension://') || f.filename?.includes('chrome-extension://'),
      );
      if (fromExtension) return null;
      return event;
    },
  });
}

export { Sentry };
