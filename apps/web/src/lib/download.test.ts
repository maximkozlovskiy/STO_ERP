import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printPdf } from './download';

/**
 * printPdf — друк PDF із сервера (наряд-замовлення, рахунок).
 *
 * Головне правило: вікно для друку відкривається СИНХРОННО, до запиту PDF, — після await
 * браузер блокує window.open як спливаюче вікно. Запит упав → вікно закривається.
 */

type FakeWin = {
  document: Document;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};

function fakeWindow(): FakeWin {
  return {
    document: document.implementation.createHTMLDocument(''),
    closed: false,
    close: vi.fn(),
    addEventListener: vi.fn(),
  };
}

const pdfBlob = () => new Blob(['%PDF-1.4'], { type: 'application/pdf' });

describe('printPdf', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let createUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createUrl = vi.fn().mockReturnValue('blob:http://localhost/pdf-1');
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('вікно відкривається ДО запиту PDF (синхронно в обробнику кліку)', async () => {
    const order: string[] = [];
    const win = fakeWindow();
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return win as unknown as Window;
    });
    let resolve!: (b: Blob) => void;
    const load = vi.fn(() => {
      order.push('load');
      return new Promise<Blob>(r => {
        resolve = r;
      });
    });

    const done = printPdf(load, 'Наряд');
    // Ще до відповіді сервера вікно вже відкрите.
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(order).toEqual(['open', 'load']);

    resolve(pdfBlob());
    await done;
  });

  it('PDF показується у відкритому вікні: рамка з blob-URL, заголовок, друк після завантаження', async () => {
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    await printPdf(() => Promise.resolve(pdfBlob()), 'Наряд-замовлення НЗ-1');

    expect(win.document.title).toBe('Наряд-замовлення НЗ-1');
    const frame = win.document.body.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('blob:http://localhost/pdf-1');
    expect(win.close).not.toHaveBeenCalled();
    // blob-URL звільняється, коли вікно перегляду закривають.
    expect(win.addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function), {
      once: true,
    });
  });

  it('запит упав → вікно закривається, помилка летить далі', async () => {
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    await expect(printPdf(() => Promise.reject(new Error('Наряд не знайдено')))).rejects.toThrow(
      'Наряд не знайдено',
    );

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('спливаюче вікно заблоковано → друк через приховану рамку в цій сторінці', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    await printPdf(() => Promise.resolve(pdfBlob()));

    const frame = document.body.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('blob:http://localhost/pdf-1');
    expect(frame?.style.opacity).toBe('0');
    const print = vi.fn();
    Object.defineProperty(frame!.contentWindow!, 'print', { value: print, configurable: true });
    Object.defineProperty(frame!.contentWindow!, 'focus', { value: vi.fn(), configurable: true });
    frame!.dispatchEvent(new Event('load'));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('відповідь без типу application/pdf усе одно відкривається як PDF', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakeWindow() as unknown as Window);

    await printPdf(() => Promise.resolve(new Blob(['%PDF-1.4'])));

    expect((createUrl.mock.calls[0]?.[0] as Blob).type).toBe('application/pdf');
  });
});
