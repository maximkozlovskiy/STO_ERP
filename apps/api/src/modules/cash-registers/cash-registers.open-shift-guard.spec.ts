import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { CashRegistersService } from './cash-registers.service';

/**
 * BR-CASH-028 — касу з відкритою зміною (ПРРО) не можна видалити й не можна зробити нефіскальною.
 *
 * Віджет зміни є лише у фіскальної каси й питає зміну саме вибраної каси (BR-CASH-027): видалена каса
 * зникає зі списку (`GET /cash-shifts/current` з нею — 404), нефіскальна віджета не має. Зміна, що
 * лишилась OPEN, закрити (Z-звіт) було б нічим (Bug #959).
 *
 * Mutation-verify (2026-10-23): прибрати перевірку в `remove` → кейс «видалення» червоний; прибрати
 * в `update` → кейс «isFiscal:false» червоний; перевіряти зміну на будь-якому PATCH (не лише при
 * знятті «фіскальна») → кейс «перейменування» червоний.
 */
describe('CashRegistersService — каса з відкритою зміною (BR-CASH-028)', () => {
  const ORG = 'org-1';
  const REG = 'reg-1';
  const BRANCH = 'branch-1';
  let svc: CashRegistersService;
  let prisma: {
    cashRegister: {
      findFirst: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
    currency: { findFirst: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    branchProviderConfig: { findFirst: ReturnType<typeof vi.fn> };
    cashShift: { findFirst: ReturnType<typeof vi.fn> };
  };
  const cache = { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(undefined) };
  const cash = { getBalance: vi.fn().mockResolvedValue(0) };

  /** Зміна OPEN саме на касі REG цієї організації — фейк виконує умову запиту. */
  const openShiftOnReg = () =>
    prisma.cashShift.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        where.orgId === ORG &&
          where.cashRegisterId === REG &&
          where.status === 'OPEN' &&
          where.deletedAt === null
          ? { id: 'shift-1' }
          : null,
      ),
    );

  beforeEach(() => {
    prisma = {
      cashRegister: {
        findFirst: vi.fn().mockResolvedValue({
          branchId: BRANCH,
          isFiscal: true,
          fiscalProvider: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: REG,
          orgId: ORG,
          name: 'Каса',
          currencyId: 'cur-1',
          branchId: BRANCH,
          isFiscal: true,
          fiscalProvider: null,
          providerCashRegisterId: null,
          initialBalance: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          currency: { code: 'UAH', symbol: '₴' },
          branch: { name: 'Головна' },
        }),
      },
      currency: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn() },
      branchProviderConfig: { findFirst: vi.fn() },
      cashShift: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    svc = new CashRegistersService(prisma as never, cache as never, cash as never);
  });

  // guards: BR-CASH-028
  it('видалення каси з відкритою зміною → 400 «спершу закрийте зміну», каса не видаляється', async () => {
    openShiftOnReg();
    const err = await svc.remove(ORG, REG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(translateError('err.cashRegister.shiftOpen', 'uk'));
    expect(prisma.cashRegister.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-028
  it('PATCH {isFiscal:false} при відкритій зміні → 400, каса лишається фіскальною', async () => {
    openShiftOnReg();
    await expect(svc.update(ORG, REG, { isFiscal: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.cashRegister.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-028
  it('без відкритої зміни видалення й зняття «фіскальна» проходять', async () => {
    await svc.remove(ORG, REG);
    await svc.update(ORG, REG, { isFiscal: false });
    expect(prisma.cashRegister.updateMany).toHaveBeenCalledTimes(2);
  });

  // guards: BR-CASH-028
  it('інші зміни каси при відкритій зміні дозволені: перейменування, переведення в іншу філію', async () => {
    openShiftOnReg();
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'branch-2' });
    await svc.update(ORG, REG, { name: 'Каса 2' });
    await svc.update(ORG, REG, { branchId: 'branch-2' });
    await svc.update(ORG, REG, { isFiscal: true });
    expect(prisma.cashRegister.updateMany).toHaveBeenCalledTimes(3);
  });

  it('en: текст відмови з каталогу (не літерал у сервісі)', () => {
    expect(translateError('err.cashRegister.shiftOpen', 'en')).toMatch(/open shift/i);
    expect(translateError('err.cashRegister.shiftOpen', 'uk')).toMatch(/зміна/);
  });
});
