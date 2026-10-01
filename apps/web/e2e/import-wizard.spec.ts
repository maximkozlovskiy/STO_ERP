import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * E2E майстра імпорту позицій документа (ExcelImportWizard) у ЖИВОМУ браузері.
 *
 * Покриває завдання tester-а:
 *  - реальний прохід CSV-каналу (UTF-8 BOM, роздільник кома, значення в лапках бо десяткова кома)
 *    → автодетект колонок за українською шапкою, підсвічені ролі, передперегляд;
 *  - PDF-скан / битий файл → ЗРОЗУМІЛЕ повідомлення в модалці, кнопка «Ідентифікувати» disabled,
 *    модалка НЕ порожня (regression проти тихої деградації);
 *  - рендер режиму запису (replace/append) не ламає модалку.
 *
 * Фінансова логіка append/replace/merge та SQL-перерахунок тоталів перевіряються окремо у
 * apps/api .../document-line-import.adapter.integration.spec.ts (жива БД) — тут ЛИШЕ UI-канал.
 */

// CSV: UTF-8 BOM + українська шапка + значення у лапках (десяткова кома всередині).
const CSV_WITH_BOM =
  '﻿' +
  [
    '"Артикул","Найменування","Бренд","Кількість","Ціна"',
    '"ART-001","Фільтр масляний","BOSCH","2","125,50"',
    '"ART-002","Колодки гальмівні","TRW","4","1 250,00"',
  ].join('\r\n');

// «PDF-скан»: валідний PDF-заголовок без текстового шару (image-only сурогат) — бекенд має
// повернути дружнє 400, а не 500. Мінімальний валідний-на-вигляд PDF без тексту.
const FAKE_SCAN_PDF = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';

/** Відкрити create-modal PO, обрати постачальника, відкрити майстер імпорту. */
async function openImportWizard(page: Page): Promise<{ wizard: ReturnType<Page['locator']> }> {
  await page.goto('/purchase-orders');
  await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('button', { name: /^Замовлення$/ })
    .first()
    .click();

  const modal = page.locator('[role="dialog"]').first();
  await expect(modal).toBeVisible({ timeout: 8_000 });

  // Постачальник (обов'язковий для майстра — counterpartyId).
  await modal.locator('button[aria-label="Обрати"]').first().click();
  const supplierPicker = page
    .locator('[role="dialog"]')
    .filter({ has: page.locator('input[placeholder="Назва, телефон, компанія..."]') })
    .first();
  await expect(supplierPicker).toBeVisible({ timeout: 5_000 });
  const firstSupplier = supplierPicker.locator('button.w-full.text-left').first();
  await expect(firstSupplier).toBeVisible({ timeout: 5_000 });
  await firstSupplier.click();
  await expect(supplierPicker).not.toBeVisible({ timeout: 5_000 });

  // Склад обов'язковий (schema: warehouseId required) — інакше handleCreate не поверне docId
  // і майстер не відкриється.
  const warehouseSelect = modal
    .locator('select, [role="combobox"]')
    .filter({ hasText: /Оберіть склад|Головний склад/ })
    .first();
  if (await warehouseSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const opts = await warehouseSelect.locator('option').count();
    if (opts > 1) await warehouseSelect.selectOption({ index: 1 });
  }

  // «Завантажити з Excel» → створює чернетку PO й відкриває майстер.
  await modal.getByRole('button', { name: /Завантажити з Excel/ }).click();

  // Майстер — окремий діалог із заголовком «Завантаження товарів з файлу».
  const wizard = page
    .locator('[role="dialog"]')
    .filter({ hasText: 'Завантаження товарів з файлу' })
    .first();
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  return { wizard };
}

test.describe('Майстер імпорту позицій — живий браузер', () => {
  test('CSV (BOM, лапки, десяткова кома) → автодетект колонок + передперегляд', async ({
    page,
  }) => {
    const { wizard } = await openImportWizard(page);

    // Файл-інпут присутній (канал .xlsx/.csv/.pdf).
    const fileInput = wizard.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    await fileInput.setInputFiles({
      name: 'invoice.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(CSV_WITH_BOM, 'utf-8'),
    });

    // Передперегляд з'явився (сирі рядки файлу).
    await expect(wizard.getByText('Передперегляд файлу')).toBeVisible({ timeout: 15_000 });

    // Автодетект спрацював: підказка про автовизначення + ролі у шапці передперегляду.
    await expect(
      wizard.getByText(/Колонки визначено автоматично|Застосовано збережені колонки/),
    ).toBeVisible({ timeout: 8_000 });
    // Хоча б одна роль-колонка підсвічена (напр. «· Артикул» або «· Ціна» у th).
    await expect(
      wizard.locator('th', { hasText: /· (Артикул|Назва|Ціна|К-сть|Бренд)/ }).first(),
    ).toBeVisible();

    // Значення з лапок/BOM прочиталось коректно (назва товару видима у сітці).
    await expect(wizard.getByText('Фільтр масляний')).toBeVisible();

    // Кнопка «Ідентифікувати товари» активна (файл прочитано без помилки).
    await expect(wizard.getByRole('button', { name: /Ідентифікувати товари/ })).toBeEnabled();

    await page.keyboard.press('Escape');
  });

  test('PDF без текстового шару → зрозуміле повідомлення, кнопка disabled, модалка не порожня', async ({
    page,
  }) => {
    const { wizard } = await openImportWizard(page);

    await wizard.locator('input[type="file"]').setInputFiles({
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(FAKE_SCAN_PDF, 'latin1'),
    });

    // Повідомлення про помилку в модалці (НЕ toast) — має залишитись видимим.
    const errorBox = wizard.locator('.bg-warning-subtle, [class*="warning"]').filter({
      hasText: /PDF|текстов|розпізна|Excel|CSV|не вдалося|сканован/i,
    });
    await expect(errorBox.first()).toBeVisible({ timeout: 20_000 });

    // Кнопка «Ідентифікувати товари» заблокована (previewError).
    await expect(wizard.getByRole('button', { name: /Ідентифікувати товари/ })).toBeDisabled();

    // Модалка НЕ порожня: шапка й поля мапінгу на місці.
    await expect(wizard.getByText(/Файл \(Excel, CSV або PDF\)/)).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
