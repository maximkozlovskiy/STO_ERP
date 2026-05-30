/** @type {import("eslint").Linter.Config} */
// Sprint A2: enable ONLY the canonical react-hooks rules (rules-of-hooks +
// exhaustive-deps). The `plugin:react-hooks/recommended` preset in v7.x adds
// experimental rules (`set-state-in-effect`, `immutability`) that would block
// pre-commit on legacy code — opt-in later via a dedicated cleanup sprint.
module.exports = {
  extends: ['./base.js', 'next/core-web-vitals'],
  plugins: ['react-hooks'],
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
