// Сторінка наряду — «Друк наряду» і «Зберегти PDF» (BR-WO-013): серверний PDF наряд-замовлення
// лише від «Виконано»; для наряду, позначеного на видалення (BR-WO-012), кнопок немає.
// Друк відкриває вікно ДО запиту; запит упав → вікно закрито, текст помилки — на сторінку.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { WorkOrderPrintButtons } from '../WorkOrderPrintButtons';

const apiBlobFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiBlobFetch: (...args: unknown[]) => apiBlobFetchMock(...args),
}));

const WO_ID = '11111111-1111-4111-8111-111111111111';

const renderButtons = (status: string, isDeleted = false, onError = vi.fn()) =>
  render(
    <WorkOrderPrintButtons
      workOrderId={WO_ID}
      number="НЗ-2026-000001"
      status={status}
      isDeleted={isDeleted}
      onError={onError}
    />,
  );

const fakeWin = () => ({
  document: document.implementation.createHTMLDocument(''),
  closed: false,
  close: vi.fn(),
  addEventListener: vi.fn(),
});

describe('WorkOrderPrintButtons — гейти (BR-WO-013)', () => {
  // guards: BR-WO-013
  it.each(['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'])('%s → обидві кнопки', status => {
    renderButtons(status);
    expect(screen.getByRole('button', { name: 'Друк наряду' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти PDF' })).toBeInTheDocument();
  });

  // guards: BR-WO-013
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED'])(
    '%s → кнопок немає',
    status => {
      const { container } = renderButtons(status);
      expect(container).toBeEmptyDOMElement();
    },
  );

  // guards: BR-WO-013
  it('видалений наряд у «Виконано» → кнопок немає (BR-WO-012)', () => {
    const { container } = renderButtons('COMPLETED', true);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('WorkOrderPrintButtons — дії', () => {
  beforeEach(() => {
    apiBlobFetchMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // guards: BR-WO-013
  it('«Друк наряду»: вікно відкривається до запиту PDF, PDF саме цього наряду', async () => {
    const order: string[] = [];
    const win = fakeWin();
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return win as unknown as Window;
    });
    apiBlobFetchMock.mockImplementation((path: string) => {
      order.push(path);
      return Promise.resolve(new Blob(['%PDF'], { type: 'application/pdf' }));
    });
    renderButtons('COMPLETED');

    await userEvent.click(screen.getByRole('button', { name: 'Друк наряду' }));

    await waitFor(() => expect(order).toEqual(['open', `/work-orders/${WO_ID}/pdf`]));
    expect(win.document.title).toBe('Наряд-замовлення НЗ-2026-000001');
    expect(win.close).not.toHaveBeenCalled();
  });

  it('«Друк наряду»: сервер відмовив → вікно закрито, текст помилки передано сторінці', async () => {
    const win = fakeWin();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    apiBlobFetchMock.mockRejectedValue(
      new Error('Наряд-замовлення друкується після виконання робіт'),
    );
    const onError = vi.fn();
    renderButtons('COMPLETED', false, onError);

    await userEvent.click(screen.getByRole('button', { name: 'Друк наряду' }));

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenLastCalledWith('Наряд-замовлення друкується після виконання робіт');
  });

  it('«Зберегти PDF»: завантаження файла з номером наряду, без вікна', async () => {
    const openSpy = vi.spyOn(window, 'open');
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });
    apiBlobFetchMock.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    renderButtons('PAID');

    await userEvent.click(screen.getByRole('button', { name: 'Зберегти PDF' }));

    await waitFor(() => expect(downloadName).toBe('work-order-НЗ-2026-000001.pdf'));
    expect(apiBlobFetchMock).toHaveBeenCalledWith(`/work-orders/${WO_ID}/pdf`);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
