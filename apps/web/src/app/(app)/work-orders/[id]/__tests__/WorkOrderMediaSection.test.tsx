// WorkOrderMediaSection — фото наряду. BR-WO-012: для наряду, позначеного на видалення, секція
// лише показує файли: сервер на завантаження й видалення відповідає 404, тож цих дій немає.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WorkOrderMediaSection } from '../WorkOrderMediaSection';

const apiFetchMock = vi.fn();
const apiMultipartFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: (...args: unknown[]) => apiMultipartFetchMock(...args),
}));

const PHOTO = {
  id: 'm-1',
  workOrderId: 'wo-1',
  filename: 'bumper.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  uploadedBy: 'e1',
  signedUrl: 'http://files.test/bumper.jpg',
  createdAt: '2026-10-13T08:00:00.000Z',
};

const dropFile = (target: Element) =>
  fireEvent.drop(target, {
    dataTransfer: { files: [new File(['x'], 'new.jpg', { type: 'image/jpeg' })] },
  });

describe('WorkOrderMediaSection', () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockResolvedValue({});
    apiMultipartFetchMock.mockReset().mockResolvedValue({});
  });

  it('звичайний наряд: є «Додати фото», видалення файла і завантаження перетягуванням', async () => {
    const onChanged = vi.fn();
    render(<WorkOrderMediaSection woId="wo-1" media={[PHOTO]} onChanged={onChanged} />);

    expect(screen.getByRole('button', { name: 'Додати фото' })).toBeInTheDocument();

    dropFile(screen.getByAltText('bumper.jpg'));
    await waitFor(() =>
      expect(apiMultipartFetchMock).toHaveBeenCalledWith(
        '/work-orders/wo-1/media',
        expect.any(FormData),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Видалити файл' }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/work-orders/wo-1/media/m-1', {
        method: 'DELETE',
      }),
    );
  });

  it('readOnly: фото видно й відкривається, але додати, перетягнути чи видалити не можна', () => {
    render(<WorkOrderMediaSection woId="wo-1" media={[PHOTO]} onChanged={vi.fn()} readOnly />);

    expect(screen.queryByRole('button', { name: 'Додати фото' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Видалити файл' })).not.toBeInTheDocument();

    dropFile(screen.getByAltText('bumper.jpg'));
    expect(apiMultipartFetchMock).not.toHaveBeenCalled();

    // Перегляд лишається: клік по фото відкриває його на весь екран.
    fireEvent.click(screen.getByAltText('bumper.jpg'));
    expect(screen.getByRole('dialog', { name: 'Перегляд фото' })).toBeInTheDocument();
  });

  it('readOnly без файлів: замість запрошення перетягнути — «Фото немає»', () => {
    render(<WorkOrderMediaSection woId="wo-1" media={[]} onChanged={vi.fn()} readOnly />);
    expect(screen.getByText('Фото немає')).toBeInTheDocument();
    expect(screen.queryByText(/Перетягніть фото сюди/)).not.toBeInTheDocument();
  });

  it('контроль: звичайний наряд без файлів запрошує перетягнути фото', () => {
    render(<WorkOrderMediaSection woId="wo-1" media={[]} onChanged={vi.fn()} />);
    expect(screen.getByText(/Перетягніть фото сюди/)).toBeInTheDocument();
  });
});
