// useEscapeLayer — стек шарів Escape (lib/escape-layers): Escape отримує лише верхній шар, решта
// слухачів (вікно під ним, React onKeyDown полів) його не бачать. Замінив useEscapeCapture і
// прапорці «вкладене відкрито» (useNestedOpenFlag, useConfirm().openRef) — техборг §15.12.

import { useState, type ReactNode } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach, type Mock } from 'vitest';
import { useEscapeLayer } from './useEscapeLayer';
import { escapeLayerCount } from '@/lib/escape-layers';

let bubbleListener: Mock<(e: KeyboardEvent) => void>;
let inside: HTMLDivElement;
let outside: HTMLInputElement;

beforeEach(() => {
  // Будь-який інший слухач Escape на document (bubble), як колишній <Modal>.
  bubbleListener = vi.fn<(e: KeyboardEvent) => void>();
  document.addEventListener('keydown', bubbleListener);
  inside = document.createElement('div');
  inside.appendChild(document.createElement('input'));
  outside = document.createElement('input');
  document.body.append(inside, outside);
});

afterEach(() => {
  document.removeEventListener('keydown', bubbleListener);
  inside.remove();
  outside.remove();
});

const press = (target: Element, key = 'Escape') =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('useEscapeLayer — один шар', () => {
  it('активний: Escape кличе onEscape і далі не йде', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeLayer(true, onEscape));
    press(outside);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(bubbleListener).not.toHaveBeenCalled();
  });

  it('неактивний: Escape проходить далі', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeLayer(false, onEscape));
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('інші клавіші не перехоплюються', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeLayer(true, onEscape));
    press(outside, 'Enter');
    expect(onEscape).not.toHaveBeenCalled();
    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('після деактивації шару немає, а без шарів немає й слухача', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const onEscape = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeLayer(active, onEscape), {
      initialProps: { active: true },
    });
    expect(escapeLayerCount()).toBe(1);
    rerender({ active: false });
    const removedCapture = remove.mock.calls.some(
      ([type, , opts]) => type === 'keydown' && opts === true,
    );
    remove.mockRestore();
    expect(escapeLayerCount()).toBe(0);
    expect(removedCapture).toBe(true);
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('scopeRef: Escape зсередини — шару, ззовні — проходить далі', () => {
    const onEscape = vi.fn();
    const scopeRef = { current: inside };
    renderHook(() => useEscapeLayer(true, onEscape, scopeRef));
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(bubbleListener).toHaveBeenCalledTimes(1);
    press(inside.querySelector('input') as HTMLInputElement);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('новий onEscape на рендері — без перереєстрації, кличеться свіжий', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useEscapeLayer(true, cb), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    const keydownAdds = add.mock.calls.filter(([type]) => type === 'keydown').length;
    add.mockRestore();
    press(outside);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(keydownAdds).toBe(1);
  });
});

describe('useEscapeLayer — стек', () => {
  it('Escape отримує лише шар, відкритий останнім; після його зняття — попередній', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const a = renderHook(() => useEscapeLayer(true, lower));
    const b = renderHook(({ active }) => useEscapeLayer(active, upper), {
      initialProps: { active: true },
    });
    press(outside);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    b.rerender({ active: false });
    press(outside);
    expect(lower).toHaveBeenCalledTimes(1);
    expect(upper).toHaveBeenCalledTimes(1);
    a.unmount();
  });

  it('повторно відкритий шар стає верхнім', () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = renderHook(({ active }) => useEscapeLayer(active, first), {
      initialProps: { active: true },
    });
    renderHook(() => useEscapeLayer(true, second));
    a.rerender({ active: false });
    a.rerender({ active: true });
    press(outside);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('батько й дитина, відкриті одним рендером: верхня — дитина (ефекти йдуть від дитини)', () => {
    const parent = vi.fn();
    const child = vi.fn();
    function Child() {
      useEscapeLayer(true, child);
      return null;
    }
    function Parent({ children }: { children: ReactNode }) {
      useEscapeLayer(true, parent);
      return <>{children}</>;
    }
    render(
      <Parent>
        <Child />
      </Parent>,
    );
    press(outside);
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
  });

  it('scoped-шар, подія поза ним: Escape дістається шару нижче, а не всім', () => {
    const windowLayer = vi.fn();
    const list = vi.fn();
    renderHook(() => useEscapeLayer(true, windowLayer));
    renderHook(() => useEscapeLayer(true, list, { current: inside }));
    press(outside);
    expect(list).not.toHaveBeenCalled();
    expect(windowLayer).toHaveBeenCalledTimes(1);
    expect(bubbleListener).not.toHaveBeenCalled();
  });

  it('одна подія — один шар: вкладене закривається й ререндерить власника, власник лишається', () => {
    // У браузері React рендерить між слухачами однієї події: раніше вікно-власник бачило вже
    // закрите вкладене й закривалось тим самим Escape (GOTCHAS 2026-10-12).
    const ownerClosed = vi.fn();
    function Owner() {
      const [nestedOpen, setNestedOpen] = useState(true);
      const [renders, setRenders] = useState(0);
      useEscapeLayer(true, ownerClosed);
      useEscapeLayer(nestedOpen, () => {
        setNestedOpen(false);
        setRenders(r => r + 1);
      });
      return <span data-renders={renders} />;
    }
    render(<Owner />);
    press(outside);
    expect(ownerClosed).not.toHaveBeenCalled();
    press(outside);
    expect(ownerClosed).toHaveBeenCalledTimes(1);
  });
});
