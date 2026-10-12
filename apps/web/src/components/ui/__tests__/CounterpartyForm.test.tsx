import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ReactNode } from 'react';
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
function Harness({
  type,
  values,
  typeAside,
  fail,
}: {
  type: 'CLIENT' | 'SUPPLIER';
  values?: Partial<CounterpartyFormInput>;
  typeAside?: ReactNode;
  /** Поле, якому тест ставить помилку валідації кнопкою «fail». */
  fail?: keyof CounterpartyFormInput;
}) {
  const {
    register,
    control,
    watch,
    setError,
    formState: { errors },
  } = useForm<CounterpartyFormInput>({
    resolver: zodResolver(counterpartyFormSchema),
    defaultValues: { ...emptyCounterpartyForm(type), ...values },
  });
  return (
    <>
      <CounterpartyForm
        register={register}
        errors={errors}
        control={control}
        watch={watch}
        typeAside={typeAside}
      />
      {fail && (
        <button type="button" onClick={() => setError(fail, { message: 'помилка поля' })}>
          fail
        </button>
      )}
    </>
  );
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

// Рішення власника 2026-10-12: «Юридичні реквізити» й «Банківські реквізити» згорнуті за
// замовчуванням; статуси стоять у рядку з «Типом».
//
// Mutation-verify: `useState(true)` у FormSection → кейс «згорнуті за замовчуванням» падає;
// прибрати `|| hasError` → кейс «помилка розкриває секцію» падає; розмонтовувати вміст замість
// `hidden` → кейс «поля лишаються у формі» падає; прибрати `filled` → кейс «заповнено» падає;
// не рендерити `typeAside` → кейс «статуси в рядку з типом» падає.
describe('CounterpartyForm — згортувані секції і рядок «Тип»', () => {
  const section = (title: string) => screen.getByRole('button', { name: new RegExp(title) });
  const content = (title: string) =>
    document.getElementById(section(title).getAttribute('aria-controls')!)!;

  it('обидві секції згорнуті за замовчуванням; клік розкриває й згортає', () => {
    render(<Harness type="CLIENT" />);
    for (const title of ['Юридичні реквізити', 'Банківські реквізити']) {
      expect(section(title)).toHaveAttribute('aria-expanded', 'false');
      expect(content(title).hidden).toBe(true);
    }
    fireEvent.click(section('Юридичні реквізити'));
    expect(section('Юридичні реквізити')).toHaveAttribute('aria-expanded', 'true');
    expect(content('Юридичні реквізити').hidden).toBe(false);
    // сусідня секція від цього не розкривається
    expect(content('Банківські реквізити').hidden).toBe(true);
    fireEvent.click(section('Юридичні реквізити'));
    expect(content('Юридичні реквізити').hidden).toBe(true);
  });

  it('поля згорнутої секції лишаються у формі (не розмонтовуються) зі своїми значеннями', () => {
    render(<Harness type="CLIENT" values={{ edrpou: '12345678', bankAccount: 'UA12' }} />);
    expect(content('Юридичні реквізити').hidden).toBe(true);
    expect(screen.getByLabelText('ЄДРПОУ')).toHaveValue('12345678');
    expect(screen.getByLabelText('IBAN')).toHaveValue('UA12');
  });

  it('згорнута секція із заповненими полями позначена «заповнено», порожня — ні', () => {
    render(<Harness type="CLIENT" values={{ edrpou: '12345678' }} />);
    expect(section('Юридичні реквізити')).toHaveTextContent('заповнено');
    expect(section('Банківські реквізити')).not.toHaveTextContent('заповнено');
    // у розкритій секції позначка зайва — поля й так видно
    fireEvent.click(section('Юридичні реквізити'));
    expect(section('Юридичні реквізити')).not.toHaveTextContent('заповнено');
  });

  it('помилка валідації в згорнутій секції розкриває її сама — інакше помилки не видно', () => {
    render(<Harness type="CLIENT" fail="legalForm" />);
    expect(content('Юридичні реквізити').hidden).toBe(true);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'fail' }));
    });
    expect(section('Юридичні реквізити')).toHaveAttribute('aria-expanded', 'true');
    expect(content('Юридичні реквізити').hidden).toBe(false);
    expect(content('Банківські реквізити').hidden).toBe(true);
  });

  it('статуси в рядку з типом: typeAside стоїть поруч із полем «Тип», в одній сітці', () => {
    render(<Harness type="CLIENT" typeAside={<div data-testid="aside">Статуси</div>} />);
    const aside = screen.getByTestId('aside');
    const row = aside.closest('.grid')!;
    expect(row).toHaveClass('grid-cols-2');
    expect(row.contains(screen.getByLabelText(/Тип/))).toBe(true);
  });

  it('без typeAside «Тип» займає всю ширину (окремої сітки немає)', () => {
    render(<Harness type="CLIENT" />);
    expect(screen.getByLabelText(/Тип/).closest('.grid-cols-2')).toBeNull();
  });
});
