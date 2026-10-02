/**
 * lint-staged.
 *
 * ESLint запускається ЛИШЕ на staged-файлах, і з них відсіюються ігноровані
 * (`*.spec.ts`, `e2e/`, конфіги). Фільтр обов'язковий: ESLint 8 на проігнорованому файлі
 * видає warning «File ignored because of a matching ignore pattern», а `--max-warnings=0`
 * перетворює його на помилку — перший же коміт після вмикання хука впав саме так.
 * Опція `--no-warn-ignored` існує лише в ESLint 9 (у проєкті 8.57), тож фільтруємо самі
 * через `ESLint.isPathIgnored`.
 *
 * Повний `tsc` у хук свідомо НЕ додано: type-aware ESLint на одному модулі йде ~39с, а
 * `tsc` по всьому репо зробив би кожен коміт нестерпним — і хук почали б обходити через
 * `--no-verify`. Типи перевіряє CI, включно з тестами (`tsconfig.spec.json`).
 */
const { ESLint } = require('eslint');

/**
 * Шляхи ОБОВ'ЯЗКОВО в лапках: корінь проєкту містить пробіл («STO ERP»), і просте
 * `files.join(' ')` розривало кожен шлях на два неіснуючі — перший же коміт упав із
 * «No files matching the pattern were found: E:/Git/STO».
 */
const quote = files => files.map(f => JSON.stringify(f)).join(' ');

const removeIgnored = async files => {
  const eslint = new ESLint();
  const kept = await Promise.all(
    files.map(async f => {
      try {
        return (await eslint.isPathIgnored(f)) ? null : f;
      } catch {
        // Файл поза будь-яким ESLint-конфігом (`packages/*` лінту не мають — аудит
        // 2026-10 це зафіксував) → isPathIgnored кидає «no-config-found». Для хука це
        // не помилка: такий файл просто не лінтується. Без catch падав увесь коміт.
        return null;
      }
    }),
  );
  return kept.filter(Boolean);
};

module.exports = {
  '*.{ts,tsx}': async files => {
    const lintable = await removeIgnored(files);
    const tasks = [`prettier --write ${quote(files)}`];
    // БЕЗ --max-warnings=0: у проєкті ~2700 свідомих warn (`no-unsafe-*` на межі з
    // Prisma/моками, знижені до warn навмисно). Із цим прапорцем хук блокував би КОЖЕН
    // коміт у відповідні файли — перевірено, власний коміт упав саме так. Хук валить
    // лише на errors (дефолтна поведінка eslint: exit 1 при error, 0 при warn).
    if (lintable.length) tasks.push(`eslint --fix ${quote(lintable)}`);
    return tasks;
  },
  '*.{js,json,md,yml,yaml}': files => [`prettier --write ${quote(files)}`],
};
