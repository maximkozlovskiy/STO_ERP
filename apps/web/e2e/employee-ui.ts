import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Співробітники в E2E — через інтерфейс (рішення власника 2026-10-19: документи й співробітники
 * створюються так, як їх створює користувач): форма «Новий співробітник» на сторінці
 * «Співробітники», закріплення за підйомниками й зонами — вкладкою «Зони та підйомники» картки.
 * Видалення в `afterAll` лишається через API (прибирання, не передумова).
 */

export type EmployeeRoleKey = 'MECHANIC' | 'ADMIN' | 'RECEPTIONIST' | 'STOREKEEPER';

export interface EmployeeUiInput {
  firstName: string;
  lastName: string;
  /** За замовчуванням форма пропонує «Механік». */
  role?: EmployeeRoleKey;
  /** «Надати доступ до системи»: логін і пароль (пароль — лише в пам'яті прогону). */
  login?: { email: string; password: string };
  /** Назви підйомників, за якими закріпити співробітника (картка, «Зони та підйомники»). */
  liftNames?: string[];
}

const isPost = (path: RegExp) => (r: { url(): string; request(): { method(): string } }) =>
  r.request().method() === 'POST' && path.test(new URL(r.url()).pathname);

/** Створює співробітника формою «Новий співробітник»; повертає id з відповіді сервера. */
export async function createEmployeeViaUi(page: Page, input: EmployeeUiInput): Promise<string> {
  await page.goto('/employees');
  // Кнопка — «Співробітник», заголовок сторінки — «Співробітники».
  const addBtn = page
    .locator('button:has-text("Співробітник"):not(:has-text("Співробітники"))')
    .first();
  await expect(addBtn).toBeVisible({ timeout: 30_000 });
  await addBtn.click();
  const modal = page.getByRole('dialog').filter({ hasText: 'Новий співробітник' });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  await modal.getByPlaceholder('Іван').fill(input.firstName);
  await modal.getByPlaceholder('Коваль').fill(input.lastName);
  if (input.role && input.role !== 'MECHANIC')
    await modal.getByRole('combobox', { name: /^Посада/ }).selectOption(input.role);
  if (input.login) {
    await modal.getByLabel('Надати доступ до системи').check();
    await modal.getByPlaceholder('ivan@sto.local').fill(input.login.email);
    await modal.getByPlaceholder('Мін. 6 символів').fill(input.login.password);
  }

  const created = page.waitForResponse(isPost(/\/employees$/), { timeout: 20_000 });
  await modal.getByRole('button', { name: 'Зберегти', exact: true }).click();
  const res = await created;
  expect(res.status(), `співробітник ${input.lastName}: ${await res.text()}`).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await expect(modal).toBeHidden({ timeout: 15_000 });

  if (input.liftNames?.length) await assignLiftsViaUi(page, input.lastName, input.liftNames);
  return id;
}

/** Картка співробітника зі списку «Співробітники» (пошук за прізвищем, олівець рядка). */
export async function openEmployeeCard(page: Page, lastName: string): Promise<Locator> {
  if (!new URL(page.url()).pathname.endsWith('/employees')) await page.goto('/employees');
  await page.getByPlaceholder("Пошук за ім'ям...").fill(lastName);
  const row = page.locator('table tbody tr', { hasText: lastName }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByTitle('Редагувати').click();
  const card = page.getByRole('dialog').filter({ hasText: lastName });
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

/** Закріплює співробітника за підйомниками — вкладка «Зони та підйомники» картки. */
export async function assignLiftsViaUi(
  page: Page,
  lastName: string,
  liftNames: string[],
): Promise<void> {
  const card = await openEmployeeCard(page, lastName);
  await card.getByRole('button', { name: /Зони та підйомники/ }).click();
  const liftBox = card
    .locator('div.mb-3')
    .filter({ has: page.locator('label', { hasText: /^Підйомники$/ }) });
  for (const name of liftNames) {
    // Точна назва: «Підйомник 1» не має відмітити «Підйомник 10».
    await liftBox
      .locator('label')
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator('input[type="checkbox"]')
      .check();
  }
  const saved = page.waitForResponse(isPost(/\/employees\/[^/]+\/lifts$/), { timeout: 20_000 });
  await card.getByRole('button', { name: 'Зберегти', exact: true }).click();
  expect((await saved).status(), 'закріплення за підйомником').toBeLessThan(300);
  await expect(card).toBeHidden({ timeout: 15_000 });
}
