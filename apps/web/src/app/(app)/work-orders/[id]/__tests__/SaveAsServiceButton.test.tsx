// «Зберегти як послугу» (BR-WO-036): діалог назви → норми робіт каталогу (`GET /works?ids=`) →
// `POST /services` з роботами (Σ годин ÷ норма), товарами (сума) і описом «Створено з наряду N»,
// без ціни. Подвійний клік не створює двох послуг; відмова сервера лишає діалог із помилкою.
//
// Mutation-verify: прибрати перевірку `savingRef` у save → «повторне збереження» падає (два POST); слати `price` →
// «тіло запиту» падає; закривати діалог у catch → «помилка сервера» падає.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

import { SaveAsServiceButton } from '../SaveAsServiceButton';

const LINES = [
  { workId: 'w-1', normoHours: 1.5 },
  { workId: 'w-1', normoHours: 2 },
  { workId: 'w-2', normoHours: 3 },
];
const PARTS = [
  { goodId: 'g-1', quantity: 2 },
  { goodId: 'g-1', quantity: 1 },
];

const posts = () => apiFetchMock.mock.calls.filter(c => c[0] === '/services');

let postResult: () => Promise<unknown>;

beforeEach(() => {
  push.mockReset();
  toastSuccess.mockReset();
  apiFetchMock.mockReset();
  postResult = () => Promise.resolve({ id: 'svc-1' });
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith('/works?ids='))
      return Promise.resolve({
        items: [
          { id: 'w-1', normoHours: 1 },
          { id: 'w-2', normoHours: 1.5 },
        ],
      });
    if (path === '/services') return postResult();
    return Promise.resolve({ items: [] });
  });
});

function openDialog() {
  render(<SaveAsServiceButton number="НРД-7" lines={LINES} parts={PARTS} />);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти як послугу' }));
}

describe('SaveAsServiceButton (BR-WO-036)', () => {
  // guards: BR-WO-036
  it('типова назва — «Наряд <номер>»; тіло запиту — групи робіт і товарів, опис, без ціни', async () => {
    openDialog();
    expect(screen.getByLabelText('Назва послуги')).toHaveValue('Наряд НРД-7');

    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(posts()).toHaveLength(1));

    expect(apiFetchMock.mock.calls[0]![0]).toBe('/works?ids=w-1,w-2&limit=200');
    const body = JSON.parse(String((posts()[0]![1] as { body: string }).body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      name: 'Наряд НРД-7',
      description: 'Створено з наряду НРД-7',
      works: [
        { workId: 'w-1', quantity: 3.5 },
        { workId: 'w-2', quantity: 2 },
      ],
      goods: [{ goodId: 'g-1', quantity: 3 }],
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [message, , action] = toastSuccess.mock.calls[0] as [
      string,
      number,
      { onClick: () => void },
    ];
    expect(message).toBe('Послугу «Наряд НРД-7» збережено');
    action.onClick();
    expect(push).toHaveBeenCalledWith(
      '/catalog?tab=services&q=%D0%9D%D0%B0%D1%80%D1%8F%D0%B4%20%D0%9D%D0%A0%D0%94-7',
    );
  });

  it('порожня назва — помилка під полем, запиту немає', async () => {
    openDialog();
    fireEvent.change(screen.getByLabelText('Назва послуги'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText('Вкажіть назву послуги')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('повторне збереження поки триває перше (клік, Enter у полі) — одна послуга', async () => {
    let release: (v: unknown) => void = () => undefined;
    postResult = () => new Promise(r => (release = r));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    // Кнопка вже неактивна, але Enter у полі назви сабмітить форму в обхід неї.
    fireEvent.submit(screen.getByLabelText('Назва послуги').closest('form')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    release({ id: 'svc-1' });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  it('помилка сервера — діалог лишається відкритим із текстом помилки', async () => {
    postResult = () => Promise.reject(new Error('Товари не знайдено'));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Товари не знайдено');
    expect(screen.getByLabelText('Назва послуги')).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
