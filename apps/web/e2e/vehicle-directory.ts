import { expect, type Locator, type Page } from '@playwright/test';
import type { ApiResult } from './api-helpers';

/**
 * Марка й модель авто — з довідника (BR-VEH-008): `POST /vehicles` приймає `makeId` / `modelId`,
 * назви пише сервер. Спеки, яким авто потрібне лише як передумова, беруть пару звідси.
 *
 * `call` — запит від імені користувача спеки (`apiCall` / `apiRequest` / локальна обгортка `api`):
 * помічник не прив'язаний ні до сторінки, ні до `APIRequestContext`.
 *
 * Марка чи модель є — повертається наявна (жива, або відновлена, якщо видалена); немає —
 * створюється. Довідник спільний для прогонів, тож нічого тут не прибирається: «Toyota / Corolla»
 * — звичайні записи довідника, а не тестові дані.
 */
export type ApiCaller = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiResult<unknown>>;

interface DirectoryEntry {
  id: string;
  name: string;
  deletedAt?: string | null;
}

const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

const itemsOf = (body: unknown): DirectoryEntry[] =>
  ((body as { items?: DirectoryEntry[] } | null)?.items ?? []) as DirectoryEntry[];

async function ensureEntry(
  call: ApiCaller,
  listPath: string,
  createPath: string,
  restorePath: (id: string) => string,
  name: string,
): Promise<string> {
  const list = await call('GET', `${listPath}?showDeleted=true`);
  expect(list.status, `${listPath}: ${JSON.stringify(list.body)}`).toBe(200);
  const found = itemsOf(list.body).find(e => nameKey(e.name) === nameKey(name));
  if (found && !found.deletedAt) return found.id;
  if (found) {
    const restored = await call('POST', restorePath(found.id));
    expect(restored.status, `відновлення ${name}: ${JSON.stringify(restored.body)}`).toBe(200);
    return found.id;
  }
  const created = await call('POST', createPath, { name });
  expect(created.status, `створення ${name}: ${JSON.stringify(created.body)}`).toBe(201);
  return (created.body as DirectoryEntry).id;
}

export async function ensureVehicleModel(
  call: ApiCaller,
  make: string,
  model: string,
): Promise<{ makeId: string; modelId: string }> {
  const makeId = await ensureEntry(
    call,
    '/vehicle-makes',
    '/vehicle-makes',
    id => `/vehicle-makes/${id}/restore`,
    make,
  );
  const modelId = await ensureEntry(
    call,
    `/vehicle-makes/${makeId}/models`,
    `/vehicle-makes/${makeId}/models`,
    id => `/vehicle-models/${id}/restore`,
    model,
  );
  return { makeId, modelId };
}

/**
 * Поле марки / моделі у формі авто — як поле клієнта (EntityPickerField): пошук під час введення
 * і «…» → вікно вибору з пошуком і всім списком. `scope` — сторінка чи вікно з формою.
 */
export type VehicleDirectoryKind = 'make' | 'model';

export const vehicleDirectoryField = (scope: Page | Locator, kind: VehicleDirectoryKind): Locator =>
  scope.getByRole('group', { name: kind === 'make' ? /^Марка/ : /^Модель/ });

/** Обрати пошуком у полі: ввести частину назви → рядок випадного списку. */
export async function searchVehicleDirectory(
  scope: Page | Locator,
  kind: VehicleDirectoryKind,
  query: string,
  name: string,
): Promise<void> {
  const field = vehicleDirectoryField(scope, kind);
  await field.getByRole('combobox').fill(query);
  await field.getByRole('option', { name, exact: true }).click();
  await expect(field).toContainText(name);
}

/** Обрати через «…»: вікно вибору показує весь список, пошук звужує, клік по рядку закриває. */
export async function pickVehicleDirectory(
  page: Page,
  scope: Page | Locator,
  kind: VehicleDirectoryKind,
  name: string,
): Promise<void> {
  const field = vehicleDirectoryField(scope, kind);
  await field.getByRole('button', { name: 'Обрати', exact: true }).click();
  const picker = page.getByRole('dialog', {
    name: kind === 'make' ? 'Оберіть марку' : 'Оберіть модель',
  });
  await picker.getByRole('textbox').fill(name);
  await picker.getByRole('button', { name, exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(field).toContainText(name);
}
