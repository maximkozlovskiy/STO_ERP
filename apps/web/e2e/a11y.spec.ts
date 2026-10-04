import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Доступність (axe-core) — РЕЖИМ ХРАПОВИКА, не «все має бути зелено».
 *
 * ЧОМУ ЦЕ ВАРТО: інтерфейсом щодня користуються з планшетів у цеху — контраст на
 * яскравому світлі, попадання пальцем, читання з відстані. Автоматика ловить ~30-40%
 * реальних проблем, але регресії виду «кнопка-іконка без доступного імені» чи
 * «select без назви» — надійно й дешево.
 *
 * ЧОМУ БАЗОВА ЛІНІЯ, А НЕ `expect([])`. На момент впровадження (2026-10-04) у застосунку
 * вже 39 порушень serious/critical шести типів. Тест, що падає з першого дня, швидко
 * починають ігнорувати або вимикають — користі нуль. Натомість фіксуємо ПОІМЕННО, які
 * правила вже порушені на якій сторінці, і валимо набір, щойно:
 *   · зʼявиться НОВЕ правило (регресія нового типу), або
 *   · наявне правило розповзеться на сторінку, де його не було.
 * Тобто борг зафіксований і не росте, а кожне виправлення звужує лінію.
 *
 * ЯК ЗМЕНШУВАТИ: виправили правило на сторінці — приберіть його з `BASELINE`. Тест тоді
 * стереже, що воно не повернеться. Коли список порожній — замініть перевірку на
 * `expect(ids).toEqual([])` і приберіть цей механізм.
 *
 * НЕ підвищуйте поріг до `minor`/`moderate` зараз: це додало б десятки зауважень рівня
 * «landmark-unique» і розмило б сигнал.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = new Set(['serious', 'critical']);

/**
 * Відомі порушення на 2026-10-04 (виміряно, не припущено). Кожен запис — борг:
 *  · color-contrast — скрізь: тема не дотягує 4.5:1 на частині тексту;
 *  · select-name — рідні `<select>` без aria-label (calendar, counterparties, reports);
 *  · button-name — кнопки-іконки без доступного імені;
 *  · label — поля форми без звʼязаного label (налаштування);
 *  · scrollable-region-focusable — прокручуваний контейнер без доступу з клавіатури.
 */
const BASELINE: Record<string, string[]> = {
  '/work-orders': ['button-name', 'color-contrast', 'select-name'],
  '/counterparties': ['color-contrast', 'select-name'],
  '/invoices': ['button-name', 'color-contrast'],
  '/inventory': ['color-contrast', 'scrollable-region-focusable', 'select-name'],
  '/settings': ['color-contrast', 'label'],
  '/login': ['color-contrast'],
};

/** Як у console-errors.spec: на цих сторінках networkidle не настає (SSE/polling). */
const LONG_LIVED = ['/dashboard', '/calendar'];

async function auditPage(page: import('@playwright/test').Page, route: string) {
  await page.goto(route, { waitUntil: LONG_LIVED.includes(route) ? 'load' : 'networkidle' });
  // Чекаємо реальний контент, інакше axe перевірить порожній каркас і «пройде».
  await expect(page.locator('h1, [role="heading"], form').first()).toBeVisible({
    timeout: 20_000,
  });

  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = violations.filter(v => BLOCKING.has(v.impact ?? ''));

  const known = new Set(BASELINE[route] ?? []);
  const fresh = blocking.filter(v => !known.has(v.id));

  // Звіт має бути самодостатнім: із CI-логу видно правило, рівень і перший селектор.
  const report = fresh
    .map(
      v =>
        `  [${v.impact}] ${v.id}: ${v.help}\n    вузлів: ${v.nodes.length}, напр. ${v.nodes[0]?.target.join(' ')}`,
    )
    .join('\n');

  expect(
    fresh.map(v => v.id),
    `НОВІ порушення доступності на ${route} (поза базовою лінією):\n${report}\n` +
      'Якщо це свідома зміна — виправте розмітку, а не додавайте правило у BASELINE.',
  ).toEqual([]);

  return blocking.map(v => v.id);
}

test.describe('Доступність (axe-core)', () => {
  test.describe('Авторизовані сторінки', () => {
    test.use({ storageState: 'e2e/.auth/admin.json' });

    for (const route of [
      '/work-orders',
      '/counterparties',
      '/invoices',
      '/inventory',
      '/settings',
    ]) {
      test(`${route} — без НОВИХ порушень понад базову лінію`, async ({ page }) => {
        await auditPage(page, route);
      });
    }

    test('базова лінія не містить зайвого (виправлене — прибирати зі списку)', async ({ page }) => {
      // Зворотний бік храповика: якщо правило вже виправлене, воно має зникнути з BASELINE,
      // інакше список розростається і перестає відображати реальність.
      const stale: string[] = [];
      for (const route of ['/work-orders', '/settings']) {
        const actual = new Set(await auditPage(page, route));
        for (const id of BASELINE[route] ?? []) {
          if (!actual.has(id)) stale.push(`${route}: ${id}`);
        }
      }
      expect(
        stale,
        `Ці правила вже НЕ порушуються — приберіть їх із BASELINE у a11y.spec.ts:\n${stale.join('\n')}`,
      ).toEqual([]);
    });
  });

  test.describe('Публічні сторінки', () => {
    test('/login — без НОВИХ порушень понад базову лінію', async ({ page }) => {
      await auditPage(page, '/login');
    });
  });
});
