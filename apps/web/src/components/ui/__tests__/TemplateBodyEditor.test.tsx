// Редактор шаблону правила автоматизації (docs/objects/automation.md, BR-AUT-014): змінна
// вставляється в позицію курсора й лише з каталогу типу документа; невідома змінна й зламаний
// фрагмент `[[…]]` видно до збереження; перегляд — тим самим renderAutomationTemplate, що й двигун.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationDocumentTypeValue } from '@sto/shared';
import { TemplateBodyEditor } from '../TemplateBodyEditor';

function Harness({
  initial,
  documentType = 'WORK_ORDER',
  onSendTest,
  blocked,
}: {
  initial: string;
  documentType?: AutomationDocumentTypeValue;
  onSendTest?: () => void;
  blocked?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TemplateBodyEditor
        label="Текст повідомлення"
        value={value}
        onChange={setValue}
        documentType={documentType}
        maxLength={1000}
        onSendTest={onSendTest}
        sendTestBlockedReason={blocked}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const field = () => screen.getByLabelText(/Текст повідомлення/) as HTMLTextAreaElement;

describe('TemplateBodyEditor', () => {
  // guards: BR-AUT-014
  it('«Вставити змінну» ставить {{змінну}} у позицію курсора, а не в кінець', () => {
    render(<Harness initial="Вітаємо, ! Наряд готовий." />);
    const el = field();
    el.focus();
    el.setSelectionRange(9, 9); // після «Вітаємо, »
    fireEvent.click(screen.getByRole('button', { name: /Вставити змінну/ }));
    fireEvent.click(screen.getByRole('option', { name: /клієнт\s*\{\{clientName\}\}/ }));
    expect(screen.getByTestId('value')).toHaveTextContent(
      'Вітаємо, {{clientName}}! Наряд готовий.',
    );
  });

  // guards: BR-AUT-014
  it('каталог змінних — лише типу документа: в оплати немає номера документа й авто', () => {
    render(<Harness initial="" documentType="PAYMENT" />);
    fireEvent.click(screen.getByRole('button', { name: /Вставити змінну/ }));
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('{{totalAmount}}')).toBeInTheDocument();
    expect(within(list).queryByText('{{documentNumber}}')).toBeNull();
    expect(within(list).queryByText('{{vehicle}}')).toBeNull();
  });

  // guards: BR-AUT-014
  it('невідома змінна підсвічується одразу, з назвою документа', () => {
    render(
      <Harness initial="Оплата {{documentNumber}} на {{totalAmount}}" documentType="PAYMENT" />,
    );
    expect(screen.getByTestId('template-unknown')).toHaveTextContent('{{documentNumber}}');
    expect(screen.getByTestId('template-unknown')).toHaveTextContent('Оплата клієнта');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  // guards: BR-AUT-014
  it('незакритий чи вкладений фрагмент [[…]] — помилка; правильний — без помилки', () => {
    const { unmount } = render(<Harness initial="{{branchName}}[[, тел. {{branchPhone}}" />);
    expect(screen.getByTestId('template-fragment-error')).toBeInTheDocument();
    unmount();
    render(<Harness initial="{{branchName}}[[, тел. {{branchPhone}}]]" />);
    expect(screen.queryByTestId('template-fragment-error')).toBeNull();
    expect(screen.queryByTestId('template-unknown')).toBeNull();
  });

  // guards: BR-AUT-014
  it('перегляд: змінні з прикладу, фрагмент з порожнім телефоном зникає цілком, без порожніх місць', () => {
    render(
      <Harness initial="Вітаємо, {{clientName}}! Сума {{totalAmount}}. {{branchName}}[[, тел. {{branchPhone}}]]" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Перегляд/ }));
    const preview = screen.getByTestId('template-preview');
    expect(preview).toHaveTextContent('Вітаємо, Іван Петренко! Сума 1 250,00 грн. Головна філія');
    expect(preview).not.toHaveTextContent('тел.');
    expect(preview).not.toHaveTextContent('{{');
  });

  // guards: BR-AUT-051
  it('«Надіслати тест»: викликає колбек; незбережене правило — кнопка вимкнена з поясненням', () => {
    const onSendTest = vi.fn();
    const { unmount } = render(<Harness initial="Текст" onSendTest={onSendTest} />);
    fireEvent.click(screen.getByRole('button', { name: /Надіслати тест/ }));
    expect(onSendTest).toHaveBeenCalledTimes(1);
    unmount();
    render(<Harness initial="Текст" onSendTest={onSendTest} blocked="Спершу збережіть правило" />);
    const btn = screen.getByRole('button', { name: /Надіслати тест/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Спершу збережіть правило');
  });
});
