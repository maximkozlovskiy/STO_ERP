import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Prisma, WorkOrderStatus } from '@prisma/client';
import { transitionWorkOrderStatusInTx } from './work-order-status';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

const ORG = 'org-1';
const WO_ID = '22222222-2222-4222-8222-222222222222';

function makeTx(count = 1) {
  const updateMany = vi.fn().mockResolvedValue({ count });
  return { tx: { workOrder: { updateMany } } as unknown as Prisma.TransactionClient, updateMany };
}

describe('transitionWorkOrderStatusInTx — статус наряду в чужій транзакції', () => {
  // guards: BR-WO-001
  it('дозволений перехід → CAS по ПОТОЧНОМУ статусу (id + orgId + deletedAt:null + status)', async () => {
    const { tx, updateMany } = makeTx();
    await transitionWorkOrderStatusInTx(tx, ORG, WO_ID, 'COMPLETED', 'INVOICED');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG, deletedAt: null, status: 'COMPLETED' },
      data: { status: 'INVOICED' },
    });
  });

  // guards: BR-WO-001
  it('перехід поза WORK_ORDER_TRANSITIONS → 400, у БД нічого не пишеться', async () => {
    const { tx, updateMany } = makeTx();
    await expect(
      transitionWorkOrderStatusInTx(tx, ORG, WO_ID, 'DRAFT', 'INVOICED'),
    ).rejects.toThrow(BadRequestException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-WO-001
  it('CAS не знайшов рядка (статус уже змінив хтось інший) → 400', async () => {
    const { tx } = makeTx(0);
    await expect(
      transitionWorkOrderStatusInTx(tx, ORG, WO_ID, 'COMPLETED', 'INVOICED'),
    ).rejects.toThrow(BadRequestException);
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const)(
    'перехід у %s (має складські/фінансові side-effects) звідси заборонено — лише transition()',
    async to => {
      const { tx, updateMany } = makeTx();
      await expect(transitionWorkOrderStatusInTx(tx, ORG, WO_ID, 'APPROVED', to)).rejects.toThrow(
        /side-effects/,
      );
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  // Повна матриця from×to: одиничні кейси вище тримають лише COMPLETED→INVOICED і три заборонені
  // цілі. Якщо дозволену ціль (PAID, ARCHIVED, …) помилково перевести у «має side-effects» або
  // навпаки — жоден із них не впаде. Очікування рахується з WORK_ORDER_TRANSITIONS і з явного
  // списку цілей із side-effects, а не з мапи всередині хелпера.
  // guards: BR-WO-001
  it('уся матриця переходів: ціль із side-effects → відмова; пара з FSM → CAS; решта → 400', async () => {
    const WITH_SIDE_EFFECTS = new Set<WorkOrderStatus>(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
    const statuses = Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[];
    const seen = { refused: 0, written: 0, rejected: 0 };

    for (const from of statuses) {
      for (const to of statuses) {
        const { tx, updateMany } = makeTx();
        const run = transitionWorkOrderStatusInTx(tx, ORG, WO_ID, from, to);
        if (WITH_SIDE_EFFECTS.has(to)) {
          await expect(run, `${from}→${to}`).rejects.toThrow(/side-effects/);
          expect(updateMany, `${from}→${to}`).not.toHaveBeenCalled();
          seen.refused++;
        } else if (WORK_ORDER_TRANSITIONS[from].includes(to)) {
          await expect(run, `${from}→${to}`).resolves.toBeUndefined();
          expect(updateMany, `${from}→${to}`).toHaveBeenCalledWith({
            where: { id: WO_ID, orgId: ORG, deletedAt: null, status: from },
            data: { status: to },
          });
          seen.written++;
        } else {
          await expect(run, `${from}→${to}`).rejects.toThrow(BadRequestException);
          expect(updateMany, `${from}→${to}`).not.toHaveBeenCalled();
          seen.rejected++;
        }
      }
    }

    // Контроль від порожнього циклу: кожна з трьох гілок справді виконувалась.
    expect(seen.refused).toBe(statuses.length * WITH_SIDE_EFFECTS.size);
    expect(seen.written).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
    expect(seen.refused + seen.written + seen.rejected).toBe(statuses.length ** 2);
  });
});

/**
 * Статичний сторож BR-WO-001. Unit-тести з моками не бачать, що десь у ІНШОМУ модулі з'явився
 * прямий запис статусу наряду — саме так `completion-acts` роками писав `INVOICED` повз FSM.
 * Цей тест читає весь прод-код `apps/api/src` і валиться, якщо знайде запис статусу наряду поза
 * двома дозволеними файлами.
 *
 * Сторож fail-closed: виклик, чий `data` він не може прочитати як літерал (змінна, shorthand,
 * spread, виклик функції), — теж порушення. Перша версія такі форми мовчки пропускала, а саме
 * так пише сам `transition()` (`data: updates`).
 *
 * ЧОГО ВІН НЕ БАЧИТЬ (свідомо — regex, не AST):
 *  - делегат через псевдонім: `const wo = tx.workOrder; wo.update(...)`;
 *  - динамічний делегат: `(prisma as any)[model].update(...)` (так пише sync push — там статус
 *    наряду захищає `PUSH_FIELD_WHITELIST`, а не цей тест);
 *  - сирий SQL, де назва таблиці зібрана з частин.
 */
describe('BR-WO-001 — статус наряду пишеться лише у двох місцях', () => {
  const SRC = join(__dirname, '..', '..');
  const ALLOWED = new Set([
    'modules/work-orders/work-orders.service.ts',
    'modules/work-orders/work-order-status.ts',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.ts') && !name.includes('.spec.') && !name.includes('.spec-fixture.'))
        out.push(full);
    }
    return out;
  }

  /** Текст від `open` (індекс відкривної дужки) до парної закривної, включно. */
  function balanced(src: string, open: number, l: string, r: string): string {
    let depth = 0;
    let i = open;
    do {
      if (src[i] === l) depth++;
      else if (src[i] === r) depth--;
      i++;
    } while (i < src.length && depth > 0);
    return src.slice(open, i);
  }

  const short = (text: string) => text.replace(/\s+/g, ' ').slice(0, 120);

  /** Записи статусу наряду: виклики делегата, вкладений запис через зв'язок, сирий SQL. */
  function statusWrites(src: string): string[] {
    const hits: string[] = [];

    // 1. tx.workOrder.update( / updateMany( / upsert( — також tx['workOrder'].update(
    const call =
      /\bworkOrder['"]?\s*\]?\s*\.\s*(?:update|updateMany|updateManyAndReturn|upsert)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(src)) !== null) {
      const body = balanced(src, call.lastIndex - 1, '(', ')');
      // update/updateMany несуть зміни в `data:`, upsert — в `update:`
      const key = /\b(?:data|update)\s*:\s*/.exec(body);
      if (!key) {
        hits.push(`data не літерал (не перевірити): ${short(m[0] + body.slice(1))}`);
        continue;
      }
      const at = key.index + key[0].length;
      if (body[at] !== '{') {
        hits.push(`data не літерал (не перевірити): ${short(m[0] + body.slice(1))}`);
        continue;
      }
      const data = balanced(body, at, '{', '}');
      if (/\.\.\./.test(data)) hits.push(`spread у data (не перевірити): ${short(data)}`);
      else if (/(^|[{,\s])status\s*[:,}]/.test(data)) hits.push(short(m[0] + body.slice(1)));
    }

    // 2. вкладений запис із іншої моделі: invoice.update({ data: { workOrder: { update: {…} } } })
    const nested = /\bworkOrder\s*:\s*\{\s*(?:update|updateMany|upsert)\s*:/g;
    while ((m = nested.exec(src)) !== null) hits.push(`вкладений запис: ${short(m[0])}`);

    // 3. сирий SQL
    const raw = /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?work_orders"?/gi;
    while ((m = raw.exec(src)) !== null) hits.push(`сирий SQL: ${short(m[0])}`);

    return hits;
  }

  // guards: BR-WO-001
  it('жоден файл поза двома дозволеними не пише workOrder.status напряму', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      for (const hit of statusWrites(readFileSync(file, 'utf-8'))) offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('детектор справді бачить прямий запис статусу (контроль: інакше тест вище завжди зелений)', () => {
    const bad = `await tx.workOrder.update({ where: { id, orgId }, data: { status: 'INVOICED' } });`;
    const ok = `await tx.workOrder.update({ where: { id, orgId }, data: { paidAmount: { increment: 1 } } });`;
    expect(statusWrites(bad)).toHaveLength(1);
    expect(statusWrites(ok)).toHaveLength(0);
  });

  // guards: BR-WO-001
  it.each([
    ['data — змінна', `await tx.workOrder.updateMany({ where: { id, orgId }, data: updates });`],
    ['data — shorthand', `await tx.workOrder.update({ where: { id, orgId }, data });`],
    ['spread у data', `await tx.workOrder.update({ where: { id, orgId }, data: { ...patch } });`],
    ['shorthand status', `await tx.workOrder.update({ where: { id, orgId }, data: { status } });`],
    [
      'upsert',
      `await tx.workOrder.upsert({ where: { id }, create: base, update: { status: 'PAID' } });`,
    ],
    [
      'делегат через індекс',
      `await tx['workOrder'].update({ where: { id }, data: { status: s } });`,
    ],
    [
      'вкладений запис',
      `await tx.invoice.update({ where: { id, orgId }, data: { workOrder: { update: { status: 'PAID' } } } });`,
    ],
    ['сирий SQL', 'await tx.$executeRaw`UPDATE work_orders SET status = ${s} WHERE id = ${id}`;'],
    ['сирий SQL у лапках', 'await tx.$executeRaw`update "work_orders" set "status" = ${s}`;'],
  ])('детектор ловить обхідну форму: %s', (_name, code) => {
    expect(statusWrites(code).length).toBeGreaterThan(0);
  });

  it('детектор не плутає `status` у where із записом статусу (без хибних спрацювань)', () => {
    const casOnOtherField = `await this.prisma.workOrder.updateMany({
      data: { shareToken: token },
      where: { id, orgId, status: 'DRAFT', deletedAt: null },
    });`;
    const readOnly = `await tx.workOrder.findFirst({ where: { id, orgId }, select: { status: true } });`;
    expect(statusWrites(casOnOtherField)).toEqual([]);
    expect(statusWrites(readOnly)).toEqual([]);
  });
});
