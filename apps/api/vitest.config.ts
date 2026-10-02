import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
    // Обмеження потоків у КОНФІЗІ, а не прапорцем: Vitest 4 прибрав CLI-опцію
    // `--poolOptions` (CACError: Unknown option). На машинах з обмеженою пам'яттю повний
    // прогін 189 файлів без цього ліміту давав OOM у esbuild/Go-рантаймі.
    poolOptions: { threads: { maxThreads: 4 } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // `include` явний, а не лише `exclude`: Vitest 3 розширив дефолтний набір файлів
      // покриття й почав рахувати конфіги на корені пакета (.eslintrc.js, vitest.config.ts) —
      // покриття «впало» 78.63% -> 59.18% без жодної зміни в коді чи тестах. Поріг це
      // спіймав, що й мало статися. Білий список прибирає залежність цифри від дефолтів.
      include: ['src/**/*.ts'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.module.ts', 'src/main.ts'],
      // Пороги перебазовано 2026-10-02 на Vitest 5: фактично lines 62.30 / branches 57.79 /
      // functions 53.18 / statements 63.15, запас ~2 пп. Сенс — ловити РЕГРЕС, не вимагати
      // круглого числа.
      //
      // ЦИФРИ ЗМІНИЛИСЬ ДВІЧІ під час міграції 2 -> 5, хоча код і тести не чіпались:
      //  · Vitest 2 -> 3: lines 78.63 -> 59.36. Vitest 2 рахував лише файли, які
      //    ІМПОРТУВАЛИСЬ тестами; Vitest 3 бере весь `include`. У знаменник увійшли
      //    87 із 307 файлів без жодного спека (цілі модулі branches, comments) — перевірено,
      //    spec-файлів для них справді немає. Тобто 78% ПРИХОВУВАЛО непокриті модулі.
      //  · Vitest 4 -> 5: branches 78.17 -> 57.79 (методика рахунку гілок), lines 59.36 -> 62.30.
      // Перебазовуємо на реальність, а не підганяємо конфіг під стару цифру.
      thresholds: {
        lines: 60,
        branches: 55,
        functions: 51,
        statements: 61,
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
