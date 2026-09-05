// Regression-guard для unsaved-guard у create-модалках (Ф5, audit 2026-09-05).
//
// Що охороняємо (Bug #639 — потенційний false-positive/false-negative базлайну):
//   Модалки перейшли на baseline-ефект (mark-on-change після осідання стану) замість
//   десятків точкових markDirty. Ризик №1 (false-positive): відкрити модалку, НЕ чіпати
//   нічого → Escape має закрити БЕЗ діалогу «Є незбережені зміни» (базлайн озброєний,
//   isDirty=false). Якщо reset-ефект помилково лишає baselineReadyRef=false у момент
//   першого рендера, АБО reset-setState тригерить mark ПІСЛЯ озброєння — з'явиться
//   хибний діалог на чистій формі. Ризик №2 (false-negative): після зміни поля Escape
//   МАЄ показати діалог. Обидва напрямки перевірені нижче на SupplierReturnCreateModal.
//
// ⚠️ Базлайн озброюється через setTimeout(0) у reset-ефекті → тести чекають діалог
// через findBy / waitFor, а не синхронно.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

// Guard увімкнено — інакше confirmClose завжди резолвиться true (діалог не показується).
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: true }),
}));

vi.mock('@/lib/format', async () => ({
  ...(await vi.importActual<typeof import('@/lib/format')>('@/lib/format')),
  kyivToday: () => '2026-09-05',
}));

const mockWarehouses = [{ id: 'w1', name: 'Склад №1' }];

describe('SupplierReturnCreateModal — unsaved-guard baseline (Ф5, Bug #639)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/warehouses') return Promise.resolve(mockWarehouses);
      return Promise.resolve({ items: [] });
    });
  });

  it('чиста форма (нічого не змінено) → Escape закриває БЕЗ діалогу підтвердження', async () => {
    const onClose = vi.fn();
    render(<SupplierReturnCreateModal open onClose={onClose} onSaved={() => {}} />);

    // Дати базлайну озброїтись (setTimeout(0)).
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    // Немає діалогу «Є незбережені зміни»; onClose викликано напряму.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });

  it('після зміни поля (примітки) → Escape показує діалог «Є незбережені зміни», onClose НЕ викликано', async () => {
    const onClose = vi.fn();
    render(<SupplierReturnCreateModal open onClose={onClose} onSaved={() => {}} />);

    // Базлайн озброюється.
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Змінюємо поле приміток → форма стає брудною (baseline вже озброєний).
    const notes = screen.getByPlaceholderText('Додаткова інформація…');
    fireEvent.change(notes, { target: { value: 'Тест причина' } });

    fireEvent.keyDown(document, { key: 'Escape' });

    // Діалог з'явився; модалка НЕ закрилась (чекає підтвердження).
    expect(await screen.findByText('Є незбережені зміни')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
