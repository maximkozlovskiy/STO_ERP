import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CounterpartyForm,
  emptyCounterpartyForm,
  counterpartyToForm,
  formToPatch,
  validateCounterpartyForm,
  hasCounterpartyName,
} from '../CounterpartyForm';
import type { Counterparty } from '@/hooks/api/useCounterparties';

describe('CounterpartyForm helpers', () => {
  it('emptyCounterpartyForm — 16 полів, дефолт type=CLIENT', () => {
    const f = emptyCounterpartyForm();
    expect(f.type).toBe('CLIENT');
    // 16 ключів (15 полів + type)
    expect(Object.keys(f)).toHaveLength(16);
  });

  it('counterpartyToForm мапить усі поля (null→"")', () => {
    const cp = {
      id: 'c1',
      type: 'SUPPLIER',
      firstName: null,
      lastName: null,
      companyName: 'ТОВ Пост',
      edrpou: '12345678',
      vatPayer: true,
      phone: '+380...',
      email: null,
      contactPerson: null,
      notes: null,
      legalForm: 'TOV',
      legalAddress: 'Київ',
      actualAddress: null,
      bankAccount: 'UA...',
      bankName: 'ПриватБанк',
      taxNumber: null,
    } as unknown as Counterparty;
    const f = counterpartyToForm(cp);
    expect(f.type).toBe('SUPPLIER');
    expect(f.companyName).toBe('ТОВ Пост');
    expect(f.legalForm).toBe('TOV');
    expect(f.bankName).toBe('ПриватБанк');
    expect(f.email).toBe(''); // null → ''
    expect(f.vatPayer).toBe(true);
  });

  it('formToPatch: усі 16 ключів; порожні → undefined; type/vatPayer завжди present', () => {
    const f = emptyCounterpartyForm('CLIENT');
    f.firstName = 'Іван';
    f.companyName = '   '; // whitespace → undefined
    const patch = formToPatch(f);
    // 16 ключів (type + vatPayer + 14 текстових)
    expect(Object.keys(patch)).toHaveLength(16);
    expect(patch.type).toBe('CLIENT');
    expect(patch.vatPayer).toBe(false);
    expect(patch.firstName).toBe('Іван');
    expect(patch.companyName).toBeUndefined(); // whitespace-only → undefined
    expect(patch.bankName).toBeUndefined();
  });

  it('formToPatch включає юр+банк поля (раніше диз’юнктні між формами)', () => {
    const f = emptyCounterpartyForm();
    f.legalAddress = 'Київ';
    f.bankAccount = 'UA123';
    f.taxNumber = '999';
    f.edrpou = '111';
    const patch = formToPatch(f);
    // Ключове: один набір містить І юр/банк, І ЄДРПОУ (усунення desync).
    expect(patch.legalAddress).toBe('Київ');
    expect(patch.bankAccount).toBe('UA123');
    expect(patch.taxNumber).toBe('999');
    expect(patch.edrpou).toBe('111');
  });

  it('validate: без імені й компанії → помилка; з ім’ям → ок', () => {
    const empty = emptyCounterpartyForm();
    expect(validateCounterpartyForm(empty)).toMatch(/назву компанії або/);
    expect(validateCounterpartyForm({ ...empty, firstName: 'Іван' })).toBeNull();
    expect(validateCounterpartyForm({ ...empty, companyName: 'ТОВ' })).toBeNull();
  });

  // Bug #739: SUPPLIER має ПРИХОВАНІ поля Ім'я/Прізвище → назвою може бути ЛИШЕ companyName.
  it('Bug #739: SUPPLIER з приховним firstName (без companyName) → валідація ПАДАЄ', () => {
    // лишок firstName після перемикання CLIENT→SUPPLIER — поле у формі не видно
    const supplier = emptyCounterpartyForm('SUPPLIER');
    supplier.firstName = 'Іван';
    supplier.lastName = 'Коваль';
    // хоча ім'я є, для SUPPLIER воно недоступне у UI → guard має вимагати companyName
    expect(hasCounterpartyName(supplier)).toBe(false);
    expect(validateCounterpartyForm(supplier)).toMatch(/назву компанії постачальника/);
  });

  it('Bug #739: SUPPLIER з companyName → валідація ПРОХОДИТЬ', () => {
    const supplier = emptyCounterpartyForm('SUPPLIER');
    supplier.companyName = 'ТОВ Авто';
    expect(hasCounterpartyName(supplier)).toBe(true);
    expect(validateCounterpartyForm(supplier)).toBeNull();
  });

  it('Bug #739: CLIENT з firstName (без companyName) → валідація ПРОХОДИТЬ (незмінна поведінка)', () => {
    const client = emptyCounterpartyForm('CLIENT');
    client.firstName = 'Іван';
    expect(hasCounterpartyName(client)).toBe(true);
    expect(validateCounterpartyForm(client)).toBeNull();
  });
});

describe('CounterpartyForm render', () => {
  const noop = () => {};

  it('CLIENT → показує Ім’я/Прізвище + юр/банк секції', () => {
    render(<CounterpartyForm value={emptyCounterpartyForm('CLIENT')} onChange={noop} />);
    expect(screen.getByText("Ім'я")).toBeTruthy();
    expect(screen.getByText('Юридичні реквізити')).toBeTruthy();
    expect(screen.getByText('Банківські реквізити')).toBeTruthy();
    expect(screen.getByText('Платник ПДВ')).toBeTruthy();
  });

  it('SUPPLIER → приховує Ім’я/Прізвище', () => {
    render(<CounterpartyForm value={emptyCounterpartyForm('SUPPLIER')} onChange={noop} />);
    expect(screen.queryByText("Ім'я")).toBeNull();
    // Компанія лишається (required для SUPPLIER).
    expect(screen.getByText('Назва компанії')).toBeTruthy();
  });
});
