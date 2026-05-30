/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ['./base.js', 'next/core-web-vitals', 'plugin:react-hooks/recommended'],
  plugins: ['react-hooks'],
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
