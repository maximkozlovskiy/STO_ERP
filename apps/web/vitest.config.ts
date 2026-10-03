import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // node_modules/.next перенесені з мертвого vitest.config.mts (аудит 2026-10): у web
    // лежали ДВА конфіги, і експеримент (навмисна синтаксична помилка в кожному) показав,
    // що vitest бере саме .ts — отже .mts роками нічого не робив. Його видалено.
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    // Ліміт воркерів, як і в api (там 4). Без нього `turbo run test` ганяє api і web
    // ПАРАЛЕЛЬНО: api займає 4 ядра з 16, web бере решту 12 і жене всі 95 файлів разом —
    // timing-sensitive тести з userEvent голодують за CPU і падають по таймауту
    // (~1 прогін із 7, записано в GOTCHAS). 6 + 4 лишає запас для самого turbo.
    maxWorkers: 6,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
