/** @type {import("eslint").Linter.Config} */
// SonarJS (eslint-plugin-sonarjs) — ЛИШЕ правила класу «баг» (`meta.type === 'problem'`) з
// рекомендованого пресету, і всі як error. Повний пресет (230 правил) 2026-10-22 дав на прод-коді
// api+web 836 знахідок, з них 795 — стиль (no-nested-conditional 225, prefer-read-only-props 220,
// cognitive-complexity 120): такий звіт не читають, а warn-ів у проєкті вже ~2700.
// Фільтр за типом, а не список назв: нове bug-правило з оновленням плагіна вмикається саме, і
// Renovate-PR покаже його знахідки в lint.
const sonarjs = require('eslint-plugin-sonarjs');

const bugRules = Object.fromEntries(
  Object.entries(sonarjs.configs['recommended-legacy'].rules).filter(
    ([name, level]) =>
      level !== 'off' && sonarjs.rules[name.replace(/^sonarjs\//, '')]?.meta?.type === 'problem',
  ),
);

module.exports = {
  plugins: ['sonarjs'],
  rules: {
    ...bugRules,
    // Вимкнено свідомо — хибні спрацювання, порада яких ШКОДИТЬ:
    //  - different-types-comparison: 14 із 14 знахідок — захисні `=== null/undefined` там, де тип
    //    їх «виключає», але рантайм — ні. Найнебезпечніше — `arr[0] === undefined` при вимкненому
    //    noUncheckedIndexedAccess (datetime-picker-input): прибрати перевірку, як радить правило, —
    //    отримати баг на порожньому масиві;
    //  - no-alphabetical-sort: 14 із 14 — сортування id/ключів для детермінізму (ключ useQuery,
    //    порядок блокувань складу, відбиток схеми). localeCompare, якого вимагає правило, зробив би
    //    порядок залежним від локалі — для блокувань це помилка.
    //  - no-clear-text-protocols: on-prem сервер СТО працює по http у LAN (ADR-001), тож http://
    //    в адресі сервера (mobile) і фейків постачальників (тести) — задум, а не витік.
    'sonarjs/different-types-comparison': 'off',
    'sonarjs/no-alphabetical-sort': 'off',
    'sonarjs/no-clear-text-protocols': 'off',
    // Не «problem» за класифікацією плагіна, але ловлять те, що в нас траплялось:
    // однакові гілки if/тернарника (копіпаста з недописаною другою гілкою), функція-двійник,
    // дубль у класі символів регекса і регекс із квадратичним відкатом (ReDoS) — api розбирає
    // завантажені файли виписок і прайсів.
    'sonarjs/no-duplicated-branches': 'error',
    'sonarjs/no-identical-functions': 'error',
    'sonarjs/duplicates-in-character-class': 'error',
    'sonarjs/super-linear-regex': 'error',
  },
};
