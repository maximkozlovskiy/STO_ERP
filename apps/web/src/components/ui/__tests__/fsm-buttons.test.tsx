import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import { FSMButtons } from '../fsm-buttons';

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
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
