import { test, expect, type Locator, type Page } from '@playwright/test';
import { weekdayOfNextMonth } from './work-days';

test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });

/**
 * Форма запису календаря і пікер дати-часу (рішення власника 2026-10-30), через браузер:
 *  1. зміна дати при відкритій формі (BR-CAL-018, TECH-DEBT (б) №58): з незбереженими змінами —
 *     «Закрити форму без збереження?», відмова лишає і форму, і дату; без змін — форма просто
 *     закривається. «День» (‹ ›) і «Місяць» (місяць ‹ ›);
 *  2. пікер дати-часу біля нижнього краю вікна 720 px (TECH-DEBT (б) №74) — над полем, у межах
 *     вікна; прокрутка картки, що зрушила поле, закриває попап.
 *
 * Документів тест не створює (форми закриваються без збереження) — прибирати нічого.
 */

const DAY = () => weekdayOfNextMonth(15);
const NOTE = '000 E2E незбережена примітка';
const dmy = (ymd: string) => ymd.split('-').reverse().join('.');

const slotForm = (page: Page) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
    .last();

const leaveDialog = (page: Page) =>
  page.getByRole('dialog').filter({ hasText: 'Закрити форму без збереження?' });

async function openNewSlot(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Слот$/ }).click();
  const form = slotForm(page);
  await expect(form).toBeVisible({ timeout: 10_000 });
  return form;
}

const noteField = (form: Locator) =>
  form.locator('label', { hasText: 'Нотатки' }).locator('..').locator('input');

async function typeNote(form: Locator) {
  await noteField(form).fill(NOTE);
}

test.describe('Зміна дати при відкритій формі запису — BR-CAL-018', () => {
  test('«День»: незбережена форма — питання; відмова лишає форму й дату, згода — переходить', async ({
    page,
  }) => {
    const day = DAY();
    await page.goto(`/calendar?view=day&date=${day}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });

    // Без змін — «Наступний» просто закриває форму.
    await openNewSlot(page);
    await page.getByRole('button', { name: 'Наступний' }).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(slotForm(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(`date=${day}`));
    await page.getByRole('button', { name: 'Попередній' }).click();
    await expect(page).toHaveURL(new RegExp(`date=${day}`));

    // Зі змінами — питання.
    const form = await openNewSlot(page);
    await typeNote(form);
    await page.getByRole('button', { name: 'Наступний' }).click();
    const dialog = leaveDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Залишитися' }).click();
    await expect(dialog).toHaveCount(0);
    // Відмова: форма з уведеним, дата та сама.
    await expect(noteField(form)).toHaveValue(NOTE);
    await expect(page).toHaveURL(new RegExp(`date=${day}`));
    await expect(form.locator('h3')).toContainText(dmy(day));

    await page.getByRole('button', { name: 'Наступний' }).click();
    await leaveDialog(page).getByRole('button', { name: 'Закрити форму' }).click();
    await expect(slotForm(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(`date=${day}`));
  });

  test('«Місяць»: «Наступний» місяць при незбереженій формі — те саме питання', async ({
    page,
  }) => {
    const day = DAY();
    await page.goto(`/calendar?view=month&date=${day}`);
    await expect(page.locator(`[data-date="${day}"]`)).toBeVisible({ timeout: 30_000 });

    const form = await openNewSlot(page);
    await typeNote(form);
    await page.getByRole('button', { name: 'Наступний' }).click();
    await expect(leaveDialog(page)).toBeVisible();
    await leaveDialog(page).getByRole('button', { name: 'Залишитися' }).click();
    await expect(page.locator(`[data-date="${day}"]`)).toBeVisible();
    await expect(noteField(form)).toHaveValue(NOTE);

    await page.getByRole('button', { name: 'Наступний' }).click();
    await leaveDialog(page).getByRole('button', { name: 'Закрити форму' }).click();
    await expect(slotForm(page)).toHaveCount(0);
    await expect(page.locator(`[data-date="${day}"]`)).toHaveCount(0);
  });
});

test.describe('Пікер дати-часу у вікні 720 px — TECH-DEBT (б) №74', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('поле біля нижнього краю: попап над полем, у межах вікна; прокрутка картки — закриває', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    await page
      .getByRole('button', { name: /^Наряд$/ })
      .first()
      .click();
    const woModal = page.getByRole('dialog').filter({ hasText: 'Новий наряд' });
    await expect(woModal).toBeVisible({ timeout: 20_000 });

    const input = woModal
      .locator('label', { hasText: 'Дата та час завершення' })
      .first()
      .locator('..')
      .locator('input');
    // Поле — біля нижнього краю вікна: прокрутка тіла картки ставить його в самий низ.
    await input.evaluate(el => el.scrollIntoView({ block: 'end' }));
    const field = await input.boundingBox();
    expect(field, 'поле видно').not.toBeNull();

    await input.click();
    const popup = page.getByTestId('datetime-picker-popup');
    await expect(popup).toBeVisible();
    const box = await popup.boundingBox();
    expect(box).not.toBeNull();
    // Під полем попап не вмістився б — тому він над полем, цілком у вікні: «Готово» й останній
    // тиждень місяця не за краєм (раніше — під полем, нижня частина за краєм вікна).
    expect(720 - (field!.y + field!.height)).toBeLessThan(box!.height);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(field!.y);
    await expect(popup.getByRole('button', { name: 'Готово' })).toBeInViewport();

    // Прокрутка всередині попапу поля не зрушує — попап лишається.
    await popup.evaluate(el => el.dispatchEvent(new Event('scroll')));
    await expect(popup).toBeVisible();

    // Прокрутка тіла картки зрушила поле — попап закривається, а не лишається відірваним.
    await input.evaluate(el => {
      let n = el.parentElement;
      while (n && !/(auto|scroll)/.test(getComputedStyle(n).overflowY)) n = n.parentElement;
      if (!n) throw new Error('немає прокручуваного тіла картки');
      n.scrollTop += 200;
    });
    await expect(popup).toHaveCount(0);

    await woModal.getByRole('button', { name: 'Закрити' }).first().click();
  });
});
