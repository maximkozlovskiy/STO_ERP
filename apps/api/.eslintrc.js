/** @type {import("eslint").Linter.Config} */
// NestJS API lint. Базовий пресет @sto/config підключаємо через require.resolve (ESLint 8 не резолвить
// package `exports` subpath як config-ім'я, тож даємо реальний шлях до файлу пресету).
// type-aware правила (recommended-type-checked) увімкнено через parserOptions.project.
//
// Проект ніколи не лінтився type-aware → базовий прогін давав 263 error. Стратегія розблокування CI:
// реальні bug-catchers лишаємо як `error` (no-explicit-any, no-unused-vars, no-floating-promises,
// only-throw-error, consistent-type-imports), а «type-flow шум» (no-unsafe-*, restrict-template,
// no-base-to-string на Prisma/зовнішніх any) знижуємо до `warn` — не блокує CI, лишається видимим.
// Поступове підтягування warn→error — окремий tech-debt крок (GAPS T1).
const nestjsPreset = require.resolve('@sto/config/eslint/nestjs');

module.exports = {
  root: true,
  extends: [nestjsPreset],
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Type-flow шум на межі з Prisma/зовнішніми any — знижено до warn (не блокує CI).
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',
    '@typescript-eslint/no-base-to-string': 'warn',
    '@typescript-eslint/unbound-method': 'warn',
    '@typescript-eslint/no-redundant-type-constituents': 'warn',
    // inline `import('@prisma/client').Prisma.X` типи — валідний патерн для Prisma-namespace у
    // сигнатурах tx-хелперів; забороняємо лише top-level value-import типів (fixStyle), не inline-анотації.
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', disallowTypeAnnotations: false },
    ],
    // no-control-regex — навмисні sanitize-регекси (видалення \x00-\x1f з імен файлів, безпека);
    // no-irregular-whitespace — BOM-strip регекси (/^﻿/) та кирилиця. Не bug-catchers для нас.
    'no-control-regex': 'off',
    'no-irregular-whitespace': 'off',
    // Реальні bug-catchers лишаються error (за замовч. з пресету): no-explicit-any, no-unused-vars,
    // no-floating-promises, only-throw-error, no-unnecessary-type-assertion.
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '*.js',
    '**/*.spec.ts',
    '**/*.contract.spec.ts',
    '**/*.invariants.spec.ts',
    '**/*.e2e-spec.ts',
    'test/',
  ],
};
