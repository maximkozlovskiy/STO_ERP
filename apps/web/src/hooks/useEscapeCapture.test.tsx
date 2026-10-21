// useEscapeCapture — спільний capture-слухач Escape (Bug #922, шість копій зведено в один хук):
// перехоплює Escape раніше за <Modal> (bubble-слухач на document) і зупиняє його; зі `scopeRef` —
// лише Escape зсередини елемента.

import { renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach, type Mock } from 'vitest';
import { useEscapeCapture } from './useEscapeCapture';

let modalListener: Mock<(e: KeyboardEvent) => void>;
let inside: HTMLDivElement;
let outside: HTMLInputElement;

beforeEach(() => {
  // Як <Modal>: слухач на document у bubble-фазі.
  modalListener = vi.fn<(e: KeyboardEvent) => void>();
  document.addEventListener('keydown', modalListener);
  inside = document.createElement('div');
  inside.appendChild(document.createElement('input'));
  outside = document.createElement('input');
  document.body.append(inside, outside);
});

afterEach(() => {
  document.removeEventListener('keydown', modalListener);
  inside.remove();
  outside.remove();
});

const press = (target: Element, key = 'Escape') =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('useEscapeCapture', () => {
  it('активний: Escape кличе onEscape і не доходить до вікна', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeCapture(true, onEscape));
    press(outside);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(modalListener).not.toHaveBeenCalled();
  });

  it('неактивний: Escape проходить до вікна', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeCapture(false, onEscape));
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(modalListener).toHaveBeenCalledTimes(1);
  });

  it('інші клавіші не перехоплюються', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeCapture(true, onEscape));
    press(outside, 'Enter');
    expect(onEscape).not.toHaveBeenCalled();
    expect(modalListener).toHaveBeenCalledTimes(1);
  });

  it('після деактивації слухача немає', () => {
    const onEscape = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeCapture(active, onEscape), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(modalListener).toHaveBeenCalledTimes(1);
  });

  it('scopeRef: Escape зсередини — перехоплено, ззовні — проходить до вікна', () => {
    const onEscape = vi.fn();
    const scopeRef = { current: inside };
    renderHook(() => useEscapeCapture(true, onEscape, scopeRef));
    press(outside);
    expect(onEscape).not.toHaveBeenCalled();
    expect(modalListener).toHaveBeenCalledTimes(1);
    press(inside.querySelector('input') as HTMLInputElement);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(modalListener).toHaveBeenCalledTimes(1);
  });

  it('новий onEscape на рендері — без перевішування слухача, кличеться свіжий', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useEscapeCapture(true, cb), {
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
