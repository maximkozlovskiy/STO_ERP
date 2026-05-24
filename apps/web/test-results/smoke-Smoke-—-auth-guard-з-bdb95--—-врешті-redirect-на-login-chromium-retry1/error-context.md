# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> Smoke — auth guard >> захищена /work-orders без auth — врешті redirect на /login
- Location: e2e\smoke.spec.ts:24:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/(login|setup)/
Received string:  "http://localhost:3001/work-orders/"
Timeout: 15000ms

Call log:
  - Expect "toHaveURL" with timeout 15000ms
    33 × unexpected value "http://localhost:3001/work-orders/"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('Smoke — публічні сторінки', () => {
  4  |   test('кореневий URL відповідає 200', async ({ page }) => {
  5  |     const response = await page.goto('/');
  6  |     expect(response?.status()).toBeLessThan(400);
  7  |   });
  8  | 
  9  |   test('/login рендериться без помилок', async ({ page }) => {
  10 |     await page.goto('/login');
  11 |     await expect(page).toHaveURL(/\/login/);
  12 |   });
  13 | 
  14 |   test('/setup доступний без авторизації', async ({ page }) => {
  15 |     await page.goto('/setup');
  16 |     await expect(page).not.toHaveURL(/\/login/);
  17 |   });
  18 | });
  19 | 
  20 | test.describe('Smoke — auth guard', () => {
  21 |   // Окремий describe з fresh context — гарантує що жодних кросс-test cookies немає
  22 |   test.use({ storageState: { cookies: [], origins: [] } });
  23 | 
  24 |   test('захищена /work-orders без auth — врешті redirect на /login', async ({ page }) => {
  25 |     await page.goto('/work-orders');
> 26 |     await expect(page).toHaveURL(/\/(login|setup)/, { timeout: 15_000 });
     |                        ^ Error: expect(page).toHaveURL(expected) failed
  27 |   });
  28 | });
  29 | 
```