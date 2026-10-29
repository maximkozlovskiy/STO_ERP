// Тест-перепис точок запису документів (сторож BR-AUT-060): кожне створення документа й кожен запис
// його статусу в сервісах api стоїть поруч із `recordDocumentEvent(tx, …)` — подією outbox у тій
// самій транзакції. Новий `tx.invoice.updateMany({ data: { status } })` без події тихо вимкнув би
// правила автоматизації для цього переходу; тут він стає червоним тестом.
//
// Як читати вікно: подія має стояти не далі за EVENT_WINDOW рядків після кінця виклику (CAS → подія
// одразу за перевіркою count). Запис, що не є подією документа (блокування рядка, службові поля,
// soft delete), — у EXEMPT з причиною.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_DOCUMENT_TYPES } from '@sto/shared';

const SRC = join(__dirname, '..', '..');

/** Prisma-делегати документів, події яких фіксує outbox (AUTOMATION_DOCUMENT_TYPES). */
const DOCUMENT_MODELS: Record<string, (typeof AUTOMATION_DOCUMENT_TYPES)[number]> = {
  workOrder: 'WORK_ORDER',
  invoice: 'INVOICE',
  purchaseOrder: 'PURCHASE_ORDER',
  stockDocument: 'STOCK_DOCUMENT',
  payment: 'PAYMENT',
  supplierPayment: 'SUPPLIER_PAYMENT',
  supplierReturn: 'SUPPLIER_RETURN',
  bookingRequest: 'BOOKING',
  task: 'TASK',
};

const EVENT_WINDOW = 40;
const EVENT_CALL = /\brecordDocumentEvents?\(/;

interface Exemption {
  file: string;
  model: string;
  op: string;
  /** Рядок, що є лише в тексті цього виклику (пробіли й переноси — як один пробіл). */
  marker: string;
  reason: string;
  /** Скільки викликів покриває рядок (типово 1). */
  count?: number;
}

/**
 * Записи документів, що НЕ є подією «створено» / «статус змінено». Кожен рядок — свідомий виняток;
 * сам перелік живий (тест нижче): виклик зник або змінився — рядок треба прибрати чи оновити.
 */
const EXEMPT: Exemption[] = [
  {
    file: 'modules/work-orders/work-orders.service.ts',
    model: 'workOrder',
    op: 'update',
    marker: 'include: WO_WRITE_INCLUDE',
    reason: 'applyUpdate (PATCH наряду): UpdateWorkOrderDto статусу не має (BR-WO-001)',
  },
  {
    file: 'modules/work-orders/work-orders.service.ts',
    model: 'workOrder',
    op: 'update',
    marker: 'select: LEAN_WO_SELECT',
    reason: 'applyUpdate з календаря: той самий шлях без статусу (BR-WO-024)',
  },
  {
    file: 'modules/invoices/invoices.service.ts',
    model: 'invoice',
    op: 'update',
    marker: 'where: { id, orgId }, data, include',
    reason: 'PATCH рахунку: `data` — поля форми без статусу',
  },
  {
    file: 'modules/invoices/invoices.service.ts',
    model: 'invoice',
    op: 'update',
    marker: 'where: { id, orgId }, data })',
    reason: 'PATCH рахунку наряду: ті самі поля форми; статус пише дзеркало з власною подією',
  },
  {
    file: 'modules/invoices/invoices.service.ts',
    model: 'invoice',
    op: 'update',
    marker: 'where: { id: invoiceId, orgId }, data })',
    reason: 'перерахунок сум рахунку (recalcTotals, без наряду і з нарядом): `data` — лише суми',
    count: 2,
  },
  {
    file: 'modules/tasks/tasks.service.ts',
    model: 'task',
    op: 'updateMany',
    marker: 'where: { id, orgId, deletedAt: null }, data, }',
    reason: 'PATCH задачі: поля форми, статус — лише через transition (BR-TASK-003)',
  },
  {
    file: 'modules/payments/payments.service.ts',
    model: 'payment',
    op: 'updateMany',
    marker: "fiscalStatus: 'QUEUED'",
    reason: 'повтор фіскалізації: статус чека, не оплати',
  },
  {
    file: 'modules/loyalty/loyalty.service.ts',
    model: 'payment',
    op: 'updateMany',
    marker: 'data: { reversedAt: null }',
    reason: 'блокування рядка оплати перед нарахуванням балів, не зміна (BR-CASH-024)',
  },
];

interface Call {
  file: string;
  model: string;
  op: string;
  text: string;
  /** Рядок (з 1), на якому виклик закінчується. */
  endLine: number;
  fileText: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$|spec-fixture\.ts$/.test(name) ? [full] : [];
  });
}

/** Текст від `(` до парної `)` (рядки й коментарі в аргументах Prisma-викликів не трапляються). */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === ')' || text[i] === '}' || text[i] === ']') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const CALL = new RegExp(
  `\\.(${Object.keys(DOCUMENT_MODELS).join('|')})\\.(create|createMany|upsert|update|updateMany)\\(`,
  'g',
);

function collectCalls(): Call[] {
  return sourceFiles(SRC).flatMap(full => {
    const file = relative(SRC, full).split(sep).join('/');
    const fileText = readFileSync(full, 'utf8');
    const calls: Call[] = [];
    for (const m of fileText.matchAll(CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const text = balanced(fileText, open);
      const endLine = fileText.slice(0, open + text.length).split('\n').length;
      calls.push({ file, model: m[1], op: m[2], text, endLine, fileText });
    }
    return calls;
  });
}

/** Тіло `data: { … }` виклику; `null` — `data` не літерал (змінна, spread) і його не прочитати. */
function dataLiteral(callText: string): string | null {
  const at = callText.search(/\bdata\s*:\s*\{/);
  if (at < 0) return null;
  return balanced(callText, callText.indexOf('{', at));
}

/** Чи пише виклик подію документа: створення — завжди; зміна — коли в `data` статус. */
function writesDocumentEvent(call: Call): boolean {
  if (call.op === 'create' || call.op === 'createMany' || call.op === 'upsert') return true;
  const data = dataLiteral(call.text);
  if (data === null) return true; // не прочитати — вважаємо записом статусу (fail-closed)
  // Оплата клієнта не має статусу: сторно — `reversedAt` (псевдостатус REVERSED).
  if (call.model === 'payment') return /\breversedAt\s*:(?!\s*null\b)/.test(data);
  return /(^|[^\w.])status\s*:/.test(data);
}

function hasEventNearby(call: Call): boolean {
  const lines = call.fileText.split('\n');
  const window = lines.slice(call.endLine - 1, call.endLine - 1 + EVENT_WINDOW).join('\n');
  return EVENT_CALL.test(window);
}

function exemptionFor(call: Call): Exemption | undefined {
  return EXEMPT.find(
    e =>
      e.file === call.file &&
      e.model === call.model &&
      e.op === call.op &&
      call.text.replace(/\s+/g, ' ').includes(e.marker),
  );
}

const calls = collectCalls();

describe('перепис точок запису документів — подія outbox поруч (BR-AUT-060)', () => {
  // guards: BR-AUT-060
  it('кожне створення документа й запис його статусу мають recordDocumentEvent поруч', () => {
    const offenders = calls
      .filter(writesDocumentEvent)
      .filter(c => !exemptionFor(c))
      .filter(c => !hasEventNearby(c))
      .map(c => `${c.file}:${c.endLine} ${c.model}.${c.op}`);
    expect(offenders).toEqual([]);
  });

  // guards: BR-AUT-060
  it('перепис не порожній: знайдено записи кожного типу документа', () => {
    const covered = new Set(calls.filter(writesDocumentEvent).map(c => DOCUMENT_MODELS[c.model]));
    expect([...covered].sort()).toEqual([...AUTOMATION_DOCUMENT_TYPES].sort());
  });

  it('перелік винятків живий: кожен рядок відповідає рівно одному виклику без події', () => {
    for (const e of EXEMPT) {
      const matched = calls.filter(c => exemptionFor(c) === e);
      expect(
        matched.map(c => `${c.file}:${c.endLine}`),
        e.marker,
      ).toHaveLength(e.count ?? 1);
      expect(e.reason.length, e.marker).toBeGreaterThan(10);
    }
  });

  it('виклик-подія — лише в транзакції: `recordDocumentEvent(this.prisma` ніде немає', () => {
    const offenders = sourceFiles(SRC)
      .filter(f => /recordDocumentEvents?\(\s*this\.prisma\b/.test(readFileSync(f, 'utf8')))
      .map(f => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
