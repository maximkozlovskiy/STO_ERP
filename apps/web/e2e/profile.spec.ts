import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * /profile — інформаційна картка користувача + форма зміни пароля.
 * Покриваємо: завантаження, відображення імені/ролі, валідація форми пароля,
 * наявність кнопок (не виконуємо реальну зміну, щоб не зламати E2E auth state).
 */
test.describe('Профіль користувача', () => {
  test('сторінка завантажується і показує заголовок', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });
  });

  test("відображає ім'я + роль адміна (seed)", async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });
    // Seed: Адмін СТО, role=OWNER → label "Власник"
    await expect(page.getByText(/Адмін|СТО/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Власник|OWNER/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('форма зміни пароля присутня з 3 полями', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('h2:has-text("Зміна пароля")')).toBeVisible({ timeout: 10_000 });

    const passwordInputs = page.locator('input[type="password"]');
    await expect(passwordInputs).toHaveCount(3, { timeout: 10_000 });
  });

  test('кнопка "Змінити пароль" задізейблена при порожній формі', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });
    const btn = page.locator('button:has-text("Змінити пароль")').first();
    await expect(btn).toBeDisabled({ timeout: 10_000 });
  });

  test('валідація: різні нові паролі → показує помилку', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });

    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill('admin123');
    await passwords.nth(1).fill('newpass123');
    await passwords.nth(2).fill('different456');

    const btn = page.locator('button:has-text("Змінити пароль")').first();
    await expect(btn).toBeEnabled({ timeout: 5_000 });
    await btn.click();

    // Очікуємо клієнт-side validation "Паролі не збігаються"
    await expect(page.getByText(/Паролі не збігаються/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('валідація: короткий пароль (<8 символів) → клієнт показує помилку', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('h1:has-text("Профіль")')).toBeVisible({ timeout: 20_000 });

    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill('admin123');
    await passwords.nth(1).fill('short');
    await passwords.nth(2).fill('short');

    const btn = page.locator('button:has-text("Змінити пароль")').first();
    await btn.click();

    await expect(page.getByText(/не менше 8 символів/i).first()).toBeVisible({ timeout: 5_000 });
  });
});
