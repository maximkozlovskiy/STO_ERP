import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Prisma } from '@prisma/client';
import { transitionWorkOrderStatusInTx } from './work-order-status';

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
});

/**
 * Статичний сторож BR-WO-001. Unit-тести з моками не бачать, що десь у ІНШОМУ модулі з'явився
 * прямий запис статусу наряду — саме так `completion-acts` роками писав `INVOICED` повз FSM.
 * Цей тест читає код усіх модулів і валиться, якщо знайде `workOrder.update*( … status: … )`
 * поза двома дозволеними місцями.
 */
describe('BR-WO-001 — статус наряду пишеться лише у двох місцях', () => {
  const MODULES = join(__dirname, '..');
  const ALLOWED = new Set([
    'work-orders/work-orders.service.ts',
    'work-orders/work-order-status.ts',
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

  /** Виклики `workOrder.update(` / `workOrder.updateMany(`, у чиєму `data` є ключ `status`. */
  function statusWrites(src: string): string[] {
    const hits: string[] = [];
    const call = /\bworkOrder\s*\.\s*(?:update|updateMany)\s*\(/g;
    while (call.exec(src) !== null) {
      // тіло виклику — до парної закривної дужки
      let depth = 1;
      let i = call.lastIndex;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const body = src.slice(call.lastIndex, i);
      const data = /\bdata\s*:\s*(\{[\s\S]*\}|\w+)/.exec(body);
      if (!data) continue;
      // `status:` як ключ об'єкта data, або data — змінна з назвою на кшталт `updates` (перевіряємо ім'я)
      if (/(^|[{,\s])status\s*[:,}]/.test(data[1]))
        hits.push(body.replace(/\s+/g, ' ').slice(0, 120));
    }
    return hits;
  }

  // guards: BR-WO-001
  it('жоден модуль поза work-orders не пише workOrder.status напряму', () => {
    const offenders: string[] = [];
    for (const file of walk(MODULES)) {
      const rel = relative(MODULES, file).split(sep).join('/');
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
});
