/**
 * Суми рядків у картках документів — у форматі мови інтерфейсу (`fmtMoney`): «1 234,50», а не
 * «1234.50» з `toFixed(2)` (tester 2026-10-26, TECH-DEBT (а) «Суми рядків … через toFixed(2)»).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorksTable, type WorksTableProps } from '../WorksTable';
import type { LocalLine } from '../types';

const EMPTY: Omit<LocalLine, '_key'> = {
  workId: '',
  workName: '',
  employeeId: '',
  normoHours: '',
  actualHours: '',
  price: '',
};

function props(over: Partial<WorksTableProps> = {}): WorksTableProps {
  const deleted = createRef<string[]>() as { current: string[] };
  deleted.current = [];
  return {
    lines: [
      {
        _key: 'l1',
        workId: 'w1',
        workName: 'Діагностика',
        employeeId: '',
        normoHours: '1.5',
        actualHours: '',
        price: '820.30',
      },
    ],
    setLines: vi.fn(),
    newLine: EMPTY,
    setNewLine: vi.fn(),
    showLineInput: false,
    setShowLineInput: vi.fn(),
    editingLineKey: null,
    setEditingLineKey: vi.fn(),
    editingLine: EMPTY,
    setEditingLine: vi.fn(),
    deletedLineIds: deleted,
    addLine: vi.fn(),
    employees: [],
    employeesLoaded: true,
    employeesById: new Map(),
    vatMode: 'NONE',
    vatRate: 0,
    linesTotals: { total: 1230.45, vat: 0 },
    actualTotals: { total: 0, hasAny: false },
    canEdit: false,
    canEditActual: false,
    EMPTY_LINE: EMPTY,
    toNumberOrUndefined: (raw: string) => (raw === '' ? undefined : Number(raw)),
    saving: false,
    fetchWorks: () => Promise.resolve([]),
    onNewLineWorkPicked: vi.fn(),
    onNewLineExecutorChange: vi.fn(),
    recalcPlannedHoursEnabled: false,
    setForm: vi.fn(),
    calcPlannedHoursFromLines: v => v,
    calcEndFromHours: v => v,
    setWorkPickerOpen: vi.fn(),
    setEditWorkPickerOpen: vi.fn(),
    setServicePickerOpen: vi.fn(),
    ...over,
  };
}

/** Нерозривний / вузький пробіл групи розрядів `Intl` → звичайний, щоб звіряти текст. */
const norm = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ');

describe('WorksTable — суми рядка й підсумку у форматі мови інтерфейсу', () => {
  // guards: BR-WO-033
  it('сума рядка 1,5 × 820,30 → «1 230,45», а не «1230.45»; підсумок — так само', () => {
    const { container } = render(<WorksTable {...props()} />);
    const text = norm(container.textContent);
    expect(text).toContain('1 230,45');
    expect(text).not.toContain('1230.45');
    expect(
      screen.getAllByText((_, el) => norm(el?.textContent ?? '') === '1 230,45').length,
    ).toBeGreaterThan(0);
  });

  // guards: BR-WO-033
  // Bug #1011: ціна рядка друкувалась сирим рядком форми («820.30», «1200»). Мутація: повернути
  // `{line.price || '—'}` у WorksTable — «820,30» зникає, червоний.
  it('ціна за одиницю — «820,30», а не сирий «820.30»', () => {
    const { container } = render(<WorksTable {...props()} />);
    const text = norm(container.textContent);
    expect(text).toContain('820,30');
    expect(text).not.toContain('820.30');
  });
});

/**
 * Решта карток документів (наряд, замовлення постачальнику, документ складу, повернення
 * постачальнику) рендерити повністю дорого — їх стереже сканер джерела: `toFixed(2)` у розмітці
 * картки друкує крапку замість коми й без розрядів.
 */
describe('картки документів — без toFixed(2) для сум', () => {
  const UI = join(__dirname, '..', '..');

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsxFiles(p);
      return p.endsWith('.tsx') ? [p] : [];
    });
  }

  // guards: BR-WO-033
  it('жоден компонент components/ui не друкує суму через toFixed(2)', () => {
    const offenders = tsxFiles(UI)
      // Bug #1011: prettier переносить довгий вираз на `.toFixed(` + `2,` + `)` окремими
      // рядками — пошук підрядка «.toFixed(2)» такого місця не бачив.
      .filter(f => /\.toFixed\(\s*2\s*,?\s*\)/.test(readFileSync(f, 'utf8')))
      .map(f => relative(UI, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
