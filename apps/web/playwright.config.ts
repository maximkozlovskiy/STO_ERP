import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/setup-auth.ts'],
  globalSetup: './e2e/setup-auth.ts',

  // Bug #343: Next.js dev cold compile on first request takes 15-25s.
  // beforeEach waitFor patterns need headroom above the 20s they specify.
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 2 : 2,
  fullyParallel: true,
  // 2 workers локально — запобігає rate limit (429) при паралельному /auth/refresh.
  // Dev API throttler: 10 req/min на login endpoint, burst при 4+ workers перевищує ліміт.
  workers: process.env.CI ? 2 : 4,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Автозапуск Next.js dev-сервера якщо він не запущений.
  // CI: пропускаємо (сервер запускається окремо у workflow).
  // Local: стартуємо якщо порт 3001 вільний.
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm --filter @sto/web dev',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 60_000,
        env: {
          NEXT_PUBLIC_API_URL: API_URL,
          // Вмикає E2E-auth-hatch у context.tsx (hydrate токена з localStorage + skip refresh).
          // Гейт build-time — у прод-збірці (без цієї змінної) hatch tree-shake-иться геть.
          NEXT_PUBLIC_E2E: '1',
        },
      },

  outputDir: 'test-results',
});
