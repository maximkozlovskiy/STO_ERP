// Regression-guard для useSubmitGuard (клас багів #630 / #632-636).
//
// Bug guarded (audit 2026-09-05, Bug #637):
//   Дія «Створити на основі» (clone) у рядку списку нарядів охоронялась лише
//   `useState` cloningId (`if (cloningId) return` + `disabled={cloningId === wo.id}`).
//   `useState` оновлюється тільки на НАСТУПНОМУ ре-рендері React, тож два синхронних
//   кліки в ОДНОМУ tick обидва читали cloningId === null → обидва проходили guard →
//   2 POST /work-orders/:id/clone → 2 наряди-дублі. Фікс: useSubmitGuard з синхронним
//   ref (`inFlightRef.current = true` до першого await) відсікає другий вхід у тому ж tick.
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: native HTMLElement.click() ×2 СИНХРОННО (без await/act між ними),
// щоб обидва кліки потрапили в один tick ДО re-render React. userEvent.click і
// fireEvent.click обгортають кожен клік у власний act()/чергу → React встигає
// re-renderнути й виставити disabled між кліками → хибно-зелений навіть без ref-guard.
// Native .click() ×2 у одному синхронному блоці відтворює реальну race, яку лікує
// саме синхронний ref. Дискримінація доведена нижче окремим «vulnerable»-харнесом
// (лише useState-guard) — він шле 2 виклики; useSubmitGuard-харнес шле 1.

import { render, screen, waitFor, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { vi, it, expect, describe } from 'vitest';

import { useSubmitGuard } from '../useSubmitGuard';

// Харнес, що відтворює структуру handleClone зі сторінки нарядів:
// клік → guarded async action, яка робить один "POST" (лічильник).
function GuardedHarness({ onPost }: { onPost: () => Promise<void> }) {
  const guard = useSubmitGuard();
  const [busyId, setBusyId] = useState<string | null>(null);
  const handleClick = () =>
    guard.run(async () => {
      setBusyId('wo1');
      try {
        await onPost();
      } finally {
        setBusyId(null);
      }
    });
  return (
    <button type="button" disabled={busyId === 'wo1'} onClick={() => void handleClick()}>
      Створити на основі
    </button>
  );
}

// «Vulnerable» контроль: лише useState-guard (баг ДО фіксу). Доводить, що тест
// дискримінує — цей харнес шле 2 POST на два синхронних кліки.
function VulnerableHarness({ onPost }: { onPost: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const handleClick = async () => {
    if (busyId) return; // читає СТАРИЙ стан у синхронному tick
    setBusyId('wo1');
    try {
      await onPost();
    } finally {
      setBusyId(null);
    }
  };
  return (
    <button type="button" disabled={busyId === 'wo1'} onClick={() => void handleClick()}>
      Створити на основі
    </button>
  );
}

describe('useSubmitGuard — double-submit guard (Bug #637, клас #630)', () => {
  it('два синхронних native-кліки виконують guarded-дію лише ОДИН раз', async () => {
    let resolvePost: () => void = () => {};
    const post = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolvePost = resolve;
        }),
    );

    render(<GuardedHarness onPost={post} />);
    const btn = screen.getByRole('button', { name: 'Створити на основі' }) as HTMLButtonElement;

    // Два синхронних кліки в ОДНОМУ tick — реальна race.
    btn.click();
    btn.click();

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolvePost();
    });
  });

  it('дискримінація: vulnerable-харнес (лише useState) виконує дію ДВІЧІ на ті самі кліки', async () => {
    let resolveCount = 0;
    const post = vi.fn(
      () =>
        new Promise<void>(resolve => {
          // Обидва in-flight — резолвимо будь-який виклик миттєво в act нижче.
          resolveCount++;
          resolve();
        }),
    );

    render(<VulnerableHarness onPost={post} />);
    const btn = screen.getByRole('button', { name: 'Створити на основі' }) as HTMLButtonElement;

    await act(async () => {
      btn.click();
      btn.click();
    });

    // Без синхронного ref-guard обидва кліки проходять `if (busyId) return`.
    expect(post).toHaveBeenCalledTimes(2);
    expect(resolveCount).toBe(2);
  });

  it('після завершення дії guard знову дозволяє виклик (не «залипає»)', async () => {
    const post = vi.fn(() => Promise.resolve());

    render(<GuardedHarness onPost={post} />);
    const btn = screen.getByRole('button', { name: 'Створити на основі' }) as HTMLButtonElement;

    await act(async () => {
      btn.click();
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // Другий незалежний клік ПІСЛЯ завершення першого — має пройти.
    await act(async () => {
      btn.click();
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });
});
