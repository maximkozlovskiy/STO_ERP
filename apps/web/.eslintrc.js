/** @type {import("eslint").Linter.Config} */
// STO ERP sprint A2: rules-of-hooks + exhaustive-deps enforced via shared @sto/config
// rules. eslint-config-next is intentionally NOT extended — keeps deps minimal
// (no eslint-config-next install required) and the canonical lint command is
// `pnpm exec next lint`, which still applies Next's recommended rules on its own.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  // Sprint A2: enable ONLY the canonical react-hooks rules.
  // The eslint-plugin-react-hooks 7.x `recommended` preset adds experimental rules
  // (`set-state-in-effect`, `immutability`) that would flood husky pre-commit;
  // those can be enabled in a future sprint after dedicated cleanup.
  plugins: ['react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
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
