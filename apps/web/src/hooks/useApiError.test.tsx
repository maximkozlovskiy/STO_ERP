import { act, renderHook } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { useApiError, parseApiError } from './useApiError';

describe('parseApiError', () => {
  it('Error instance → повертає message', () => {
    expect(parseApiError(new Error('Помилка'))).toBe('Помилка');
  });

  it('string → повертає рядок як є', () => {
    expect(parseApiError('Пряма помилка')).toBe('Пряма помилка');
  });

  it("невідомий тип → 'Невідома помилка'", () => {
    expect(parseApiError(null)).toBe('Невідома помилка');
    expect(parseApiError(undefined)).toBe('Невідома помилка');
    expect(parseApiError({ msg: 'bad' })).toBe('Невідома помилка');
    expect(parseApiError(42)).toBe('Невідома помилка');
  });
});

describe('useApiError', () => {
  it('початковий error = "" за замовчуванням', () => {
    const { result } = renderHook(() => useApiError());
    expect(result.current.error).toBe('');
  });

  it('початковий error з аргументу', () => {
    const { result } = renderHook(() => useApiError('Початкова'));
    expect(result.current.error).toBe('Початкова');
  });

  it('handleError(Error) → виставляє message', () => {
    const { result } = renderHook(() => useApiError());
    act(() => result.current.handleError(new Error('Збій API')));
    expect(result.current.error).toBe('Збій API');
  });

  it('handleError(string) → виставляє рядок', () => {
    const { result } = renderHook(() => useApiError());
    act(() => result.current.handleError('Пряма'));
    expect(result.current.error).toBe('Пряма');
  });

  it('handleError(unknown) → "Невідома помилка"', () => {
    const { result } = renderHook(() => useApiError());
    act(() => result.current.handleError({ random: true }));
    expect(result.current.error).toBe('Невідома помилка');
  });

  it('clearError → очищує error', () => {
    const { result } = renderHook(() => useApiError('Існуюча'));
    act(() => result.current.clearError());
    expect(result.current.error).toBe('');
  });

  it('setError працює напряму', () => {
    const { result } = renderHook(() => useApiError());
    act(() => result.current.setError('Ручна'));
    expect(result.current.error).toBe('Ручна');
  });
});
