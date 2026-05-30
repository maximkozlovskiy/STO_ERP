import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, describe, beforeEach, afterEach } from 'vitest';
import { NotificationCenter, useNotifications, type AppNotification } from '../notification-center';
import { renderHook } from '@testing-library/react';

const STORAGE_KEY = 'sto_notifications';

function seed(items: AppNotification[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

describe('NotificationCenter', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('enabled=false → не рендерить нічого', () => {
    const { container } = render(<NotificationCenter enabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('enabled=true → рендерить bell button', () => {
    render(<NotificationCenter enabled />);
    expect(screen.getByLabelText(/Сповіщення/)).toBeInTheDocument();
  });

  it('badge показує unread count', () => {
    seed([
      { id: 'n1', type: 'info', title: 'A', createdAt: Date.now(), read: false },
      { id: 'n2', type: 'info', title: 'B', createdAt: Date.now(), read: false },
      { id: 'n3', type: 'info', title: 'C', createdAt: Date.now(), read: true },
    ]);
    render(<NotificationCenter enabled />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('badge показує "9+" коли unread > 9', () => {
    const items: AppNotification[] = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      type: 'info',
      title: `T${i}`,
      createdAt: Date.now(),
      read: false,
    }));
    seed(items);
    render(<NotificationCenter enabled />);
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('клік на bell відкриває панель сповіщень', async () => {
    seed([{ id: 'n1', type: 'success', title: 'Збережено', createdAt: Date.now(), read: false }]);
    render(<NotificationCenter enabled />);
    await userEvent.click(screen.getByLabelText(/Сповіщення/));
    expect(screen.getByText('Збережено')).toBeInTheDocument();
  });

  it('порожній стан показує "Немає сповіщень"', async () => {
    render(<NotificationCenter enabled />);
    await userEvent.click(screen.getByLabelText(/Сповіщення/));
    expect(screen.getByText('Немає сповіщень')).toBeInTheDocument();
  });

  it('клік на рядок-сповіщення позначає як прочитане', async () => {
    seed([{ id: 'n1', type: 'info', title: 'Hello', createdAt: Date.now(), read: false }]);
    render(<NotificationCenter enabled />);
    await userEvent.click(screen.getByLabelText(/Сповіщення/));
    // unread badge існує перед кліком
    expect(screen.getByText('1')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Hello'));
    // після кліку badge зник
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  it('Bug #56 регресія: keydown на нащадку не викликає markRead', async () => {
    seed([{ id: 'n1', type: 'info', title: 'Hello', createdAt: Date.now(), read: false }]);
    render(<NotificationCenter enabled />);
    await userEvent.click(screen.getByLabelText(/Сповіщення/));
    expect(screen.getByText('1')).toBeInTheDocument();

    // Симулюємо keydown від нащадка (target !== currentTarget)
    const deleteBtn = screen.getByLabelText('Видалити сповіщення');
    deleteBtn.focus();
    await userEvent.keyboard(' ');
    // notification видалене кнопкою X → unread badge зникає (бо немає елементів)
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });
});

describe('useNotifications', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('початковий стан: items=[]', () => {
    const { result } = renderHook(() => useNotifications());
    expect(result.current.items).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('add додає сповіщення у початок списку', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.add('info', 'Hello', 'World');
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].title).toBe('Hello');
    expect(result.current.items[0].body).toBe('World');
    expect(result.current.items[0].read).toBe(false);
    expect(result.current.unreadCount).toBe(1);
  });

  it('add записує у localStorage', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.add('warning', 'X');
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('X');
  });

  it('markRead встановлює read=true для одного запису', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.add('info', 'A');
    });
    const id = result.current.items[0].id;
    act(() => {
      result.current.markRead(id);
    });
    expect(result.current.items[0].read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it('markAllRead позначає всі як прочитані', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.add('info', 'A');
      result.current.add('info', 'B');
    });
    expect(result.current.unreadCount).toBe(2);
    act(() => {
      result.current.markAllRead();
    });
    expect(result.current.unreadCount).toBe(0);
  });

  it('remove видаляє запис', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.add('info', 'A');
    });
    const id = result.current.items[0].id;
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.items).toHaveLength(0);
  });

  it('обмежує MAX_STORED=50 записами', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      for (let i = 0; i < 60; i++) result.current.add('info', `T${i}`);
    });
    expect(result.current.items.length).toBeLessThanOrEqual(50);
  });
});
