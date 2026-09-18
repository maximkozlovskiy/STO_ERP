import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  counterpartyFormSchema,
  hasCounterpartyName,
  type CounterpartyFormInput,
} from '@sto/shared';
import { CounterpartyForm, emptyCounterpartyForm, counterpartyToForm } from '../CounterpartyForm';
import type { Counterparty } from '@/hooks/api/useCounterparties';

describe('CounterpartyForm helpers', () => {
  it('emptyCounterpartyForm — 16 полів, дефолт type=CLIENT', () => {
    const f = emptyCounterpartyForm();
    expect(f.type).toBe('CLIENT');
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
    expect(f.email).toBe(''); // null → ''
    expect(f.vatPayer).toBe(true);
  });
});

// Валідація тепер у спільній zod-схемі (єдине джерело web↔api). Дублюємо ключові кейси у web-бандлі.
describe('counterpartyFormSchema (name-by-type, Bug #739)', () => {
  it('SUPPLIER з приховним firstName (без companyName) → падає', () => {
    expect(hasCounterpartyName({ type: 'SUPPLIER', firstName: 'Іван' })).toBe(false);
    const r = counterpartyFormSchema.safeParse({ type: 'SUPPLIER', firstName: 'Іван' });
    expect(r.success).toBe(false);
    // i18n: schema емітить validation-KEY (не укр.); rendered-рядок покрито i18nZodResolver/pipe.
    if (!r.success) expect(r.error.issues[0]?.message).toBe('v.counterparty.name.supplier');
  });

  it('SUPPLIER з companyName → проходить', () => {
    expect(
      counterpartyFormSchema.safeParse({ type: 'SUPPLIER', companyName: 'ТОВ Авто' }).success,
    ).toBe(true);
  });

  it('CLIENT з firstName (без companyName) → проходить', () => {
    expect(counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'Іван' }).success).toBe(
      true,
    );
  });

  it('CLIENT без імені/компанії → помилка на companyName', () => {
    const r = counterpartyFormSchema.safeParse({ type: 'CLIENT' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'companyName');
      expect(issue?.message).toBe('v.counterparty.name.any');
    }
  });
});

// RHF-обгортка для рендеру форми (компонент тепер керується register/control/errors).
function Harness({ type }: { type: 'CLIENT' | 'SUPPLIER' }) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = useForm<CounterpartyFormInput>({
    resolver: zodResolver(counterpartyFormSchema),
    defaultValues: emptyCounterpartyForm(type),
  });
  return <CounterpartyForm register={register} errors={errors} control={control} watch={watch} />;
}

describe('CounterpartyForm render', () => {
  it('CLIENT → показує Ім’я/Прізвище + юр/банк секції', () => {
    render(<Harness type="CLIENT" />);
    expect(screen.getByText("Ім'я")).toBeTruthy();
    expect(screen.getByText('Юридичні реквізити')).toBeTruthy();
    expect(screen.getByText('Банківські реквізити')).toBeTruthy();
    expect(screen.getByText('Платник ПДВ')).toBeTruthy();
  });

  it('SUPPLIER → приховує Ім’я/Прізвище', () => {
    render(<Harness type="SUPPLIER" />);
    expect(screen.queryByText("Ім'я")).toBeNull();
    expect(screen.getByText('Назва компанії')).toBeTruthy();
  });
});
