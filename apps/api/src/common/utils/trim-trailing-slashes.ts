/**
 * Прибирає кінцеві `/` з адреси (`https://x.com/` → `https://x.com`), щоб склеювання з шляхом не
 * дало `//`.
 *
 * Циклом, а не `replace(/\/+$/, '')`: регекс пробує кожну позицію серії слешів і на рядку з довгою
 * серією НЕ в кінці відкочується квадратично (sonarjs/super-linear-regex). Адреси приходять із
 * налаштувань організації та підключень постачальників.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}
