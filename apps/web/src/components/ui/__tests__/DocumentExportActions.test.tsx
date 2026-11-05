/**
 * «Друк» і «Зберегти як» картки рахунку, замовлення, складського документа (`DocumentEditActions`)
 * і повернення (`DocumentExportActions`) — через сервер (BR-INV-028, BR-PO-016, BR-SDOC-009,
 * BR-SRET-014). До цього «Друк» друкував вікно картки (`window.print()`), а «Зберегти як» лише
 * закривав меню.
 *
 * Мутація (2026-11-05): повернути `onSaveAs={() => setSaveAsOpen(false)}` → падає «Excel».
 */
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentEditActions } from '../document-card-actions';

const apiBlobFetchMock = vi.fn();
const apiFileFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiBlobFetch: (...a: unknown[]) => apiBlobFetchMock(...a),
  apiFileFetch: (...a: unknown[]) => apiFileFetchMock(...a),
}));
const downloadBlobMock = vi.fn();
const printPdfMock = vi.fn();
vi.mock('@/lib/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
  printPdf: (...a: unknown[]) => printPdfMock(...a),
}));
vi.mock('@/contexts/TabBarContext', () => ({
  useTabBarContext: () => ({ minimizeModal: vi.fn() }),
}));

const LABELS = {
  print: 'Друк',
  saveAs: 'Зберегти як',
  share: 'Поділитись',
  shareTitle: 'Поділитись',
  smsTitle: 'SMS',
};

function Harness({
  onError,
  withFile = true,
}: {
  onError: (m: string) => void;
  withFile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DocumentEditActions
      file={
        withFile ? { exportPath: '/invoices/inv-1/export', fallbackName: 'INV-1', onError } : null
      }
      showShare={false}
      saveAsOpen={open}
      setSaveAsOpen={setOpen}
      save={null}
      saving={false}
      busy={false}
      labels={LABELS}
    />
  );
}

describe('DocumentEditActions — друк і «Зберегти як» через сервер', () => {
  beforeEach(() => {
    apiBlobFetchMock.mockReset();
    apiFileFetchMock.mockReset();
    downloadBlobMock.mockReset();
    printPdfMock.mockReset().mockResolvedValue(undefined);
  });

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009
  it('«Зберегти як → Excel» — GET …/export/xlsx, файл з іменем із заголовка, меню закрито', async () => {
    const blob = new Blob(['x']);
    apiFileFetchMock.mockResolvedValue({ blob, filename: 'Рахунок-INV-1.xlsx' });
    render(<Harness onError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Зберегти як/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel (.xlsx)' }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledWith(blob, 'Рахунок-INV-1.xlsx'));
    expect(apiFileFetchMock).toHaveBeenCalledWith('/invoices/inv-1/export/xlsx', 'INV-1.xlsx');
    expect(screen.queryByRole('button', { name: 'Excel (.xlsx)' })).not.toBeInTheDocument();
  });

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009
  it('«Друк» — серверний PDF через printPdf (вікно до запиту), не window.print()', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<Harness onError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Друк/ }));

    expect(printPdfMock).toHaveBeenCalledTimes(1);
    expect(apiBlobFetchMock).not.toHaveBeenCalled();
    const load = printPdfMock.mock.calls[0]![0] as () => Promise<Blob>;
    await load();
    expect(apiBlobFetchMock).toHaveBeenCalledWith('/invoices/inv-1/export/pdf');
    expect(printSpy).not.toHaveBeenCalled();
    printSpy.mockRestore();
  });

  // guards: BR-INV-028
  it('відмова сервера — текст помилки в банер картки', async () => {
    apiFileFetchMock.mockRejectedValue(new Error('Рахунок не знайдено'));
    const onError = vi.fn();
    render(<Harness onError={onError} />);

    fireEvent.click(screen.getByRole('button', { name: /Зберегти як/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Word (.docx)' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Рахунок не знайдено'));
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it('незнайдений документ (file = null) — ні «Друку», ні «Зберегти як»', () => {
    render(<Harness onError={vi.fn()} withFile={false} />);

    expect(screen.queryByRole('button', { name: /Друк/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Зберегти як/ })).not.toBeInTheDocument();
  });
});
