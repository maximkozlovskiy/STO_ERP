/**
 * Хто бачить залишки — ролі на маршрутах, з яких збирається вкладка «Звіти → Залишки».
 *
 * Вкладка переїхала зі сторінки «Склад» у «Звіти» (рішення власника 2026-10-08). «Звіти» —
 * розділ бухгалтера, тож він мусить мати доступ до тих самих двох читань, що й комірник з
 * приймальником: список залишків (+ розклад по партіях) і перелік складів для фільтра.
 * Рухи й мінімальний залишок лишаються за ролями складу. Читаємо метадані `@Roles`, які
 * `RolesGuard` звіряє з роллю користувача.
 */
import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { StockItemsController } from './stock-items.controller';
import { WarehousesController } from '../warehouses/warehouses.controller';

const rolesOf = (handler: unknown): string[] =>
  [...((Reflect.getMetadata(ROLES_KEY, handler as object) as string[] | undefined) ?? [])].sort();

const VIEWERS = ['ACCOUNTANT', 'ADMIN', 'OWNER', 'RECEPTIONIST', 'STOREKEEPER'];

describe('Залишки — ролі доступу (вкладка «Звіти → Залишки»)', () => {
  it.each(['findAll', 'byBatch'] as const)(
    'stock-items.%s — власник, адміністратор, комірник, приймальник і бухгалтер',
    method => {
      expect(rolesOf(StockItemsController.prototype[method])).toEqual(VIEWERS);
    },
  );

  it('перелік складів (фільтр вкладки) бачать ті самі ролі та механік', () => {
    expect(rolesOf(WarehousesController.prototype.findAll)).toEqual(
      [...VIEWERS, 'MECHANIC'].sort(),
    );
  });

  it('stock-items.byDocument — ті самі ролі та механік', () => {
    expect(rolesOf(StockItemsController.prototype.byDocument)).toEqual(
      [...VIEWERS, 'MECHANIC'].sort(),
    );
  });

  it.each(['movements', 'findLow', 'updateMinStock'] as const)(
    'stock-items.%s лишається за ролями складу — без бухгалтера і приймальника',
    method => {
      expect(rolesOf(StockItemsController.prototype[method])).toEqual([
        'ADMIN',
        'OWNER',
        'STOREKEEPER',
      ]);
    },
  );
});
