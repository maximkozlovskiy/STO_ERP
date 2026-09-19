// Regression-guard для Bug #766 (клас #639/#747) — CurrencySelect авто-дефолт dirty-guard.
//
// Bug guarded (tester cycle 2/3, Bug #766 — dirty-guard false positive через авто-валюту):
//   CurrencySelect(defaultToBase) авто-обирає базову валюту org на mount. Раніше це йшло
//   через onChange → у формах з dirty-guard (Invoice/PO) rhfDirty=true → незаймана модалка
//   вважалась брудною → Escape/закриття хибно показувало «Є незбережені зміни».
//   Фікс: prop onAutoDefault — ПРОГРАМНИЙ авто-дефолт маршрутизується окремо від user-onChange,
//   викликач застосовує його через setValue({shouldDirty:false}).
//
// Цей тест фіксує 3 інваріанти маршрутизації напряму на компоненті (E2E покриває інтеграцію):
//   1. авто-дефолт → onAutoDefault (НЕ onChange), рівно один раз;
//   2. user-вибір опції → onChange (НЕ onAutoDefault);
//   3. без onAutoDefault (BC) → авто-дефолт падає у onChange.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CurrencySelect } from '../CurrencySelect';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const CURRENCIES = [
  { id: 'cur-uah', code: 'UAH', name: 'Гривня' },
  { id: 'cur-usd', code: 'USD', name: 'Долар' },
];

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/currencies') return Promise.resolve({ items: CURRENCIES, total: 2 });
    if (path === '/settings/organisation') return Promise.resolve({ currency: 'UAH' });
    return Promise.resolve({ items: [] });
  });
});

describe('CurrencySelect — авто-дефолт dirty-guard (Bug #766)', () => {
  it('авто-дефолт базової валюти → onAutoDefault (не onChange), рівно один раз', async () => {
    const onChange = vi.fn();
    const onAutoDefault = vi.fn();
    renderWithQueryClient(
      <CurrencySelect value="" onChange={onChange} onAutoDefault={onAutoDefault} />,
    );

    // Авто-дефолт спрацьовує коли підвантажились /currencies + базова валюта.
    await waitFor(() => expect(onAutoDefault).toHaveBeenCalledWith('cur-uah'));
    // Ключове: програмний авто-дефолт НЕ йде в user-onChange (інакше форма брудна).
    expect(onChange).not.toHaveBeenCalled();
    // Рівно один раз — echo контрольованого value не має ре-тригерити авто-дефолт.
    expect(onAutoDefault).toHaveBeenCalledTimes(1);
  });

  it('user-вибір опції → onChange (не onAutoDefault)', async () => {
    const onChange = vi.fn();
    const onAutoDefault = vi.fn();
    // value вже задано → авто-дефолт-guard блокує програмний виклик; лишається лише user-шлях.
    renderWithQueryClient(
      <CurrencySelect value="cur-uah" onChange={onChange} onAutoDefault={onAutoDefault} />,
    );

    await waitFor(() => expect(screen.getByRole('option', { name: /USD/ })).toBeInTheDocument());
    const select = screen.getByLabelText('Валюта');
    fireEvent.change(select, { target: { value: 'cur-usd' } });

    expect(onChange).toHaveBeenCalledWith('cur-usd');
    expect(onAutoDefault).not.toHaveBeenCalled();
  });

  it('без onAutoDefault (BC) → авто-дефолт падає у onChange', async () => {
    const onChange = vi.fn();
    renderWithQueryClient(<CurrencySelect value="" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('cur-uah'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
