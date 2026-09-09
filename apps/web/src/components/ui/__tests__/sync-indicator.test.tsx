import { act, render, screen } from '@testing-library/react';
import { it, expect, describe, beforeEach, afterEach, vi } from 'vitest';
import { SyncIndicator } from '../sync-indicator';

describe('SyncIndicator', () => {
  const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => {
    if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine);
  });

  it('не рендерить нічого якщо idle і ніколи не синхронізовано', () => {
    const { container } = render(<SyncIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('показує "Офлайн" коли navigator.onLine=false на mount', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    render(<SyncIndicator />);
    expect(screen.getByText('Офлайн — збереження недоступне')).toBeInTheDocument();
  });

  it('реагує на window event "offline"', () => {
    render(<SyncIndicator />);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('Офлайн — збереження недоступне')).toBeInTheDocument();
  });

  it('реагує на window event "online" (повертається до idle)', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    const { container } = render(<SyncIndicator />);
    expect(screen.getByText('Офлайн — збереження недоступне')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // idle + lastSync=null → не рендерить
    expect(container.firstChild).toBeNull();
  });

  it('реагує на CustomEvent "sto:sync-status" зі status="syncing"', () => {
    render(<SyncIndicator />);
    act(() => {
      window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'syncing' } }));
    });
    expect(screen.getByText('Синхронізація...')).toBeInTheDocument();
  });

  it('після завершення синхронізації (status=idle) показує "Синхронізовано" з lastSync', () => {
    render(<SyncIndicator />);
    act(() => {
      window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'syncing' } }));
    });
    act(() => {
      window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'idle' } }));
    });
    expect(screen.getByText('Синхронізовано')).toBeInTheDocument();
  });

  it('реагує на CustomEvent зі status="error"', () => {
    render(<SyncIndicator />);
    act(() => {
      window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'error' } }));
    });
    expect(screen.getByText('Помилка')).toBeInTheDocument();
  });

  it('cleanup: знімає обидва listener-и (online/offline + sto:sync-status) при unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<SyncIndicator />);
    unmount();
    const events = removeSpy.mock.calls.map(c => c[0]);
    expect(events).toContain('online');
    expect(events).toContain('offline');
    expect(events).toContain('sto:sync-status');
    removeSpy.mockRestore();
  });
});
