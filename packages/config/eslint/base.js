/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended-type-checked', 'prettier'],
  plugins: ['@typescript-eslint'],
  parser: '@typescript-eslint/parser',
  rules: {
    // ignoreRestSiblings: ідіома «витягнути поле, щоб відкинути» — `const { SECRET, ...rest } = env`
    // у тестах «відсутній X → кидає». Змінна навмисно не використовується, перейменовувати її
    // в `_SECRET` безглуздо: саме ім'я поля і є змістом. varsIgnorePattern — для явних заглушок.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],
};
