// Поле марки / моделі авто (`VehicleMakeModelFields`) — EntityPickerField із пошуком і вікном
// вибору «…», як поле клієнта. Спільні кроки для тестів форм, що містять ці поля: форма авто,
// картка контрагента, майстер календаря.

import { expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

export type VehicleDirectoryKind = 'make' | 'model';

const FIELD_NAME: Record<VehicleDirectoryKind, RegExp> = { make: /^Марка/, model: /^Модель/ };
const PICKER_TITLE: Record<VehicleDirectoryKind, string> = {
  make: 'Оберіть марку',
  model: 'Оберіть модель',
};

/** Група поля (підпис, значення чи поле пошуку, кнопки ×/…, помилка). */
export const vehicleDirectoryField = (kind: VehicleDirectoryKind): HTMLElement =>
  screen.getByRole('group', { name: FIELD_NAME[kind] });

/** Кнопка «…» — відкрити вікно вибору. */
export const vehicleDirectoryPickButton = (kind: VehicleDirectoryKind): HTMLElement =>
  within(vehicleDirectoryField(kind)).getByRole('button', { name: 'Обрати' });

/** Поле пошуку (видно, лише поки нічого не обрано). */
export const vehicleDirectorySearch = (kind: VehicleDirectoryKind): HTMLInputElement =>
  within(vehicleDirectoryField(kind)).getByRole('combobox') as HTMLInputElement;

/** Обрати запис через «…»: вікно вибору показує весь список, клік по рядку закриває вікно. */
export async function pickVehicleDirectoryItem(
  kind: VehicleDirectoryKind,
  name: string,
): Promise<void> {
  await waitFor(() => expect(vehicleDirectoryPickButton(kind)).toBeEnabled());
  fireEvent.click(vehicleDirectoryPickButton(kind));
  const dialog = await screen.findByRole('dialog', { name: PICKER_TITLE[kind] });
  fireEvent.click(await within(dialog).findByRole('button', { name }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: PICKER_TITLE[kind] })).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(vehicleDirectoryField(kind)).toHaveTextContent(name));
}
