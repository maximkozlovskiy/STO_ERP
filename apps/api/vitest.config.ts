import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.module.ts', 'src/main.ts'],
      // Пороги зафіксовані ВІД ФАКТИЧНОГО рівня на 2026-10-02 (lines 78.63 / branches 86.21
      // / functions 64.02), з запасом ~2 пп. Сенс — ловити РЕГРЕС, а не вимагати круглого
      // числа: поріг вище фактичного зробив би CI червоним одразу, нижче на десятки —
      // беззмістовним. Піднімати разом зі зростанням покриття.
      thresholds: {
        lines: 76,
        branches: 84,
        functions: 62,
        statements: 76,
      },
    },
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          decoratorMetadata: true,
          legacyDecorator: true,
        },
        target: 'es2022',
      },
    }),
  ],
});
