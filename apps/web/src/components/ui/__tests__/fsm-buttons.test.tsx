import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import { WO_STATUS_TRANSITIONS } from '@sto/shared';
import { FSMButtons } from '../fsm-buttons';

// Локальний фікстур ДЗЕРКАЛИТЬ shared WO_STATUS_TRANSITIONS (single source of truth).
// C2: COMPLETED += CANCELLED (реверс запчастин+боргу). Розбіжність із shared → drift-тест нижче падає.
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED', 'CANCELLED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

const LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затвердити',
  IN_PROGRESS: 'В роботу',
  ON_HOLD: 'Призупинити',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено',
  ARCHIVED: 'В архів',
  CANCELLED: 'Скасувати',
};

describe('FSMButtons', () => {
  it('рендерить лише дозволені переходи з map (DRAFT → ESTIMATE, CANCELLED)', () => {
    render(
      <FSMButtons
        status="DRAFT"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={vi.fn()}
      />,
    );
    expect(screen.getByText('Кошторис')).toBeInTheDocument();
    expect(screen.getByText('Скасувати')).toBeInTheDocument();
    // Forbidden transitions for DRAFT — should NOT render
    expect(screen.queryByText('В роботу')).not.toBeInTheDocument();
    expect(screen.queryByText('Виконано')).not.toBeInTheDocument();
    expect(screen.queryByText('Оплачено')).not.toBeInTheDocument();
  });

  it('IN_PROGRESS → лише ON_HOLD + COMPLETED (без CANCELLED — авторитет backend)', () => {
    render(
      <FSMButtons
        status="IN_PROGRESS"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={vi.fn()}
      />,
    );
    expect(screen.getByText('Призупинити')).toBeInTheDocument();
    expect(screen.getByText('Виконано')).toBeInTheDocument();
    expect(screen.queryByText('Скасувати')).not.toBeInTheDocument();
  });

  it('термінальний статус ARCHIVED → нічого не рендериться (повертає null)', () => {
    const { container } = render(
      <FSMButtons
        status="ARCHIVED"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('невідомий статус → нічого не рендериться (fallback на ?? [])', () => {
    const { container } = render(
      <FSMButtons
        status="UNKNOWN_STATUS"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('клік на кнопку викликає onTransition з правильним targetStatus', () => {
    const onTransition = vi.fn();
    render(
      <FSMButtons
        status="DRAFT"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={onTransition}
      />,
    );
    fireEvent.click(screen.getByText('Кошторис'));
    expect(onTransition).toHaveBeenCalledWith('ESTIMATE');
    fireEvent.click(screen.getByText('Скасувати'));
    expect(onTransition).toHaveBeenCalledWith('CANCELLED');
  });

  it('loading=true → кнопки залишаються (loading prop проходить у Button)', () => {
    render(
      <FSMButtons
        status="DRAFT"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={vi.fn()}
        loading
      />,
    );
    expect(screen.getByText('Кошторис')).toBeInTheDocument();
  });

  it('disabled=true → кнопки disabled і клік не викликає onTransition', () => {
    const onTransition = vi.fn();
    render(
      <FSMButtons
        status="DRAFT"
        transitions={TRANSITIONS}
        labels={LABELS}
        onTransition={onTransition}
        disabled
      />,
    );
    const btn = screen.getByText('Кошторис').closest('button')!;
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it('label не у LABELS → fallback на raw status string', () => {
    const onTransition = vi.fn();
    render(
      <FSMButtons
        status="DRAFT"
        transitions={{ DRAFT: ['UNKNOWN_TARGET'] }}
        labels={{}}
        onTransition={onTransition}
      />,
    );
    expect(screen.getByText('UNKNOWN_TARGET')).toBeInTheDocument();
  });
});

// C2 (Bug #705) — sync-gap guard проти РЕАЛЬНОЇ shared-мапи. Оригінальний CRITICAL: backend
// FSM отримав COMPLETED→CANCELLED, а frontend WO_STATUS_TRANSITIONS лишилась ['INVOICED'] →
// кнопка «Скасувати» для завершеного наряду не рендерилась → уся фіча недосяжна з UI. Ці
// тести читають ФАКТИЧНУ shared-мапу (не локальну копію) → падають, якщо мапа регресує.
describe('FSMButtons × реальна WO_STATUS_TRANSITIONS (C2 sync-gap guard)', () => {
  const LABELS_REAL: Record<string, string> = { ...LABELS, INVOICED: 'Виставити рахунок' };

  it('COMPLETED → у shared-мапі присутні і INVOICED, і CANCELLED', () => {
    // Прямий інваріант на джерело-правди: якщо хтось відкотить мапу до ['INVOICED'] — падає тут.
    expect(WO_STATUS_TRANSITIONS.COMPLETED).toContain('CANCELLED');
    expect(WO_STATUS_TRANSITIONS.COMPLETED).toContain('INVOICED');
  });

  it('COMPLETED наряд → рендериться кнопка «Скасувати» (C2 реверс досяжний з UI)', () => {
    render(
      <FSMButtons
        status="COMPLETED"
        transitions={WO_STATUS_TRANSITIONS}
        labels={LABELS_REAL}
        variants={{ CANCELLED: 'destructive' }}
        onTransition={vi.fn()}
      />,
    );
    expect(screen.getByText('Скасувати')).toBeInTheDocument();
    expect(screen.getByText('Виставити рахунок')).toBeInTheDocument();
  });

  it('клік «Скасувати» на COMPLETED → onTransition(CANCELLED)', () => {
    const onTransition = vi.fn();
    render(
      <FSMButtons
        status="COMPLETED"
        transitions={WO_STATUS_TRANSITIONS}
        labels={LABELS_REAL}
        onTransition={onTransition}
      />,
    );
    fireEvent.click(screen.getByText('Скасувати'));
    expect(onTransition).toHaveBeenCalledWith('CANCELLED');
  });

  it('INVOICED/PAID/ARCHIVED → CANCELLED недосяжний (незворотні у shared-мапі)', () => {
    expect(WO_STATUS_TRANSITIONS.INVOICED).not.toContain('CANCELLED');
    expect(WO_STATUS_TRANSITIONS.PAID).not.toContain('CANCELLED');
    expect(WO_STATUS_TRANSITIONS.ARCHIVED).toEqual([]);
  });
});
