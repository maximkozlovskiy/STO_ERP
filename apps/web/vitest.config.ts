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
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
