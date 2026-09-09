/** @type {import("eslint").Linter.Config} */
// Expo/React-Native lint. Базовий пресет @sto/config (type-aware TS) через require.resolve
// (ESLint 8 не резолвить package `exports` subpath як config-ім'я). Не використовуємо nextjs-пресет
// (він тягне next/core-web-vitals, несумісний з RN). react-hooks — базові правила.
// Type-flow шум знижено до warn (як в api); реальні bug-catchers лишаються error.
const basePreset = require.resolve('@sto/config/eslint');

module.exports = {
  root: true,
  extends: [basePreset],
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
    ecmaFeatures: { jsx: true },
  },
  rules: {
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',
    '@typescript-eslint/no-base-to-string': 'warn',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', disallowTypeAnnotations: false },
    ],
    'no-control-regex': 'off',
    'no-irregular-whitespace': 'off',
    // Mobile — pre-release (Фаза 18). sync.ts працює на межі з WatermelonDB-адаптером, де тип-контракти
    // ще не стабілізовані → no-explicit-any / no-unnecessary-type-assertion знижено до warn (не блокують
    // CI). Підтягнути до error разом зі стабілізацією offline-sync — окремий крок Фази 18.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  },
  ignorePatterns: [
    '.expo/',
    'node_modules/',
    '*.js',
    'babel.config.js',
    'metro.config.js',
    '**/*.test.ts',
    '**/*.test.tsx',
  ],
};
