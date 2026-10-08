import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `include` задається В ПРОЕКТАХ (нижче), не тут: інакше корінь зібрав би ті самі
    // файли ЩЕ РАЗ — перший прогін після введення projects дав 409 файлів / 6220 тестів
    // замість 205/3115 (кожен спек порахований двічі).
    setupFiles: ['reflect-metadata'],
    // isolate:false — спеки НЕ ізолюються у окремий модульний граф на файл: воркер
    // обчислює спільні модулі ОДИН раз, а не 2506× (по разу на кожен з 204 файлів).
    // Вимір (повний api-набір, maxWorkers:4): 76.73s → 16.40s wall, 3099/3099 green.
    // Vitest сам це радив: «~89s faster with isolate:false». import-частка 79% → 31%.
    // БЕЗПЕЧНО тут бо: немає resetModules/isolateModules (жоден спек не покладається на
    // свіжий модуль на файл), немає глобального monkeypatch без restore, усі useFakeTimers
    // мають useRealTimers/afterEach. vi.mock лишається file-scoped і скидається між файлами
    // незалежно від isolate. Якщо зʼявиться спек що МУТУЄ module-level singleton і залежить
    // від його скидання між файлами — додати restoreMocks/unstubEnvs АБО лишити той файл
    // ізольованим через test.sequence, а не вертати глобальний isolate:true.
    isolate: false,
    // ВИНЯТОК (знайдено ЦИКЛ 2/3): email.provider.spec МУСИТЬ бути ізольованим.
    // Він мокає 'nodemailer', а `EmailProvider` імпортують ще два специ
    // (provider-registry, turbosms), які не мокають. Під спільним графом провайдер
    // інколи отримував НЕмокнутий модуль → send повертав accepted:false → 5 падінь.
    // Виміряно: без ізоляції ~1 падіння на 4-5 повних прогонів; з `--isolate` 3/3 зелено.
    // Спроби полагодити на рівні спека (однаковий vi.mock у всіх трьох, resetModules +
    // динамічний import) НЕ допомогли — проблема в ідентичності модуля, не в реєстрації
    // моку. Тому точкова ізоляція саме цього файлу: решта 204 зберігають прискорення 5×.
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          include: ['src/**/*.spec.ts'],
          exclude: [
            'src/modules/notifications/providers/email.provider.spec.ts',
            'src/**/*.integration.spec.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          // Integration-спеки працюють зі СПРАВЖНІМИ модулями на живій БД, тож чужий vi.mock у
          // спільному графі для них фатальний. 2026-10-08 у CI `dead-letter.integration` потрапив
          // в один воркер із `dead-letter.service.spec` (той мокає tenant-context без
          // isTenantBypassed) — запис у БД тихо не відбувався (сервіс fail-open), 2 кейси падали.
          // Локально не відтворювалось: на 4 воркерах файли розходились по різних.
          include: [
            'src/modules/notifications/providers/email.provider.spec.ts',
            'src/**/*.integration.spec.ts',
          ],
          isolate: true,
        },
      },
    ],
    // Ліміт потоків: Vitest 4 прибрав і CLI-опцію `--poolOptions`, і вкладений
    // `test.poolOptions` — тепер це ТОП-РІВНЕВІ опції (DEPRECATED-попередження вказало
    // прямо). Поки стояло вкладене, обмеження просто ІГНОРУВАЛОСЬ.
    // Потрібне на машинах з обмеженою пам'яттю: повний прогін 189 файлів без ліміту
    // давав OOM у esbuild/Go-рантаймі.
    maxWorkers: 4,
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
