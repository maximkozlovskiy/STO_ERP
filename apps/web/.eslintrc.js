/** @type {import("eslint").Linter.Config} */
// STO ERP web lint. Next 16 ПРИБРАВ `next lint` (падало «Invalid project directory ... /lint»), тож
// канонічна команда тепер `eslint src --ext .ts,.tsx` (як api/mobile). Реєструємо @typescript-eslint
// (щоб `no-explicit-any` реально лінтився + inline-disable з ним резолвились) + react-hooks.
// НЕ вмикаємо type-checked-пресет тут (потребує parserOptions.project на всьому web) — базові
// react-hooks + no-explicit-any ловлять головні класи; поглиблення — окремий крок.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['react-hooks', '@typescript-eslint'],
  rules: {
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
