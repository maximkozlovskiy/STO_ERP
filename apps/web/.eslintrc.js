/** @type {import("eslint").Linter.Config} */
// STO ERP web lint. Next 16 ПРИБРАВ `next lint` (падало «Invalid project directory ... /lint»), тож
// канонічна команда тепер `eslint src --ext .ts,.tsx` (як api/mobile). Реєструємо @typescript-eslint
// (щоб `no-explicit-any` реально лінтився + inline-disable з ним резолвились) + react-hooks.
// Type-checked пресет УВІМКНЕНО (аудит 2026-10). Замір на момент вмикання: 390 errors, з них
// 192 no-misused-promises + 72 no-floating-promises — це НЕ шум типізації (як на api), а
// реальний борг обробки помилок: `onClick={async …}` мовчки ковтає відмову, користувач не
// бачить нічого. Виправляти наосліп не можна — кожен випадок потребує рішення, ЩО показати
// при збої, тож ці два правила тримаємо як warn: видно в звіті, CI не блокують. Решта
// type-flow шуму — warn за зразком api; bug-catchers лишаються error.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  extends: ['plugin:@typescript-eslint/recommended-type-checked'],
  plugins: ['react-hooks', '@typescript-eslint'],
  rules: {
    // Борг обробки помилок на фронті — 264 випадки на момент вмикання. Окремий крок.
    '@typescript-eslint/no-misused-promises': 'warn',
    '@typescript-eslint/no-floating-promises': 'warn',
    // Type-flow шум на межі з API-відповідями (той самий набір, що знижено на api).
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',
    '@typescript-eslint/no-base-to-string': 'warn',
    '@typescript-eslint/no-redundant-type-constituents': 'warn',
    '@typescript-eslint/restrict-plus-operands': 'warn',
    '@typescript-eslint/unbound-method': 'warn',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-explicit-any': 'error',
    // web ніколи не лінтився no-unused-vars → 53 накопичених dead-import/var. Це cleanliness, не bug —
    // тримаємо як warn (не блокує CI), підтягнути до error окремим cleanup-проходом.
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: [
    '.next/',
    'out/',
    'node_modules/',
    'next-env.d.ts',
    '*.config.*',
    'e2e/',
    '**/__tests__/**',
    '**/*.test.ts',
    '**/*.test.tsx',
    'src/__tests__/**',
  ],
};
