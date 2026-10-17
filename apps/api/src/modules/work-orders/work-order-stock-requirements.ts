import type { Prisma } from '@prisma/client';
import { safeCoeff } from '../../common/utils/math';

/**
 * Потреба наряду в товарі та резерв, який він тримає (BR-WO-021, BR-INVT-018). Спільне для
 * переходів наряду (WorkOrderStockEffectsService), списків купівлі (нестача, надсилання з наряду)
 * і приймання замовлення постачальнику (розподіл отриманого, BR-PL-011).
 *
 * Усі функції приймають клієнт (`db`) — транзакцію виклику або PrismaService — і НЕ відкривають
 * власних транзакцій.
 */

/** Клієнт Prisma: транзакція виклику або сам PrismaService (у нього ті самі делегати). */
export type StockDb = Prisma.TransactionClient;

/** Епсилон порівняння кількостей (Float у схемі; дробові одиниці — літри, кг). */
export const QTY_EPSILON = 1e-6;

/** Ключ резерв-мапи: резерв відстежується по парі (товар, склад) — один товар на двох складах
 *  резервується незалежно. */
export const stockKey = (goodId: string, warehouseId: string): string => `${goodId}|${warehouseId}`;

/** Рядок товару наряду в обсязі, потрібному для розрахунку потреби. */
export interface PartForRequirement {
  id: string;
  goodId: string;
  warehouseId: string;
  quantity: number;
  unitOfMeasureId?: string | null;
}

/**
 * Коефіцієнт одиниці рядка (`part.id → coefficient`): скільки БАЗОВИХ одиниць в одній одиниці
 * рядка («1 пакет = 12 шт» → 12). Рядок без одиниці в мапу не потрапляє (коефіцієнт 1).
 */
export async function fetchPartCoefficients(
  db: StockDb,
  orgId: string,
  parts: { id: string; unitOfMeasureId?: string | null; goodId: string }[],
): Promise<Record<string, number>> {
  const uomIds = parts.map(p => p.unitOfMeasureId).filter((id): id is string => !!id);
  if (uomIds.length === 0) return {};
  // WO-C2: WorkOrderPart.unitOfMeasureId — це FK на UnitOfMeasure.id (addPart зберігає
  // uomJunction.unitOfMeasureId), а НЕ GoodUoM.id (PK). Тож коефіцієнт беремо з GoodUoM за
  // парою (unitOfMeasureId, goodId) — унікальною у @@unique([orgId,goodId,unitOfMeasureId]).
  // A1/A3: +orgId у where — GoodUoM tenant-scoped; без нього tenant-guard кидав би на transition
  // із UoM-запчастиною (500), а коефіцієнт міг би прийти з чужої org (крос-tenant).
  const goodIds = parts.map(p => p.goodId);
  const uoms = await db.goodUoM.findMany({
    where: { orgId, unitOfMeasureId: { in: uomIds }, goodId: { in: goodIds } },
    select: { unitOfMeasureId: true, goodId: true, coefficient: true },
  });
  // Ключ = goodId|unitOfMeasureId (коефіцієнт специфічний для товару).
  const coeffByGoodUom = new Map<string, number>(
    uoms.map(u => [`${u.goodId}|${u.unitOfMeasureId}`, u.coefficient]),
  );
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.unitOfMeasureId) {
      // DTO @Min(0.000001) blocks coefficient=0 on write-path, but legacy/seed/direct-SQL
      // data may have 0. safeCoeff() handles 0/NaN/negative/undefined → 1.
      result[part.id] = safeCoeff(coeffByGoodUom.get(`${part.goodId}|${part.unitOfMeasureId}`));
    }
  }
  return result;
}

/** Потреба рядка в базових одиницях: кількість × коефіцієнт його одиниці. */
export const partBaseQty = (part: PartForRequirement, coeffMap: Record<string, number>): number =>
  part.quantity * (coeffMap[part.id] ?? 1);

/** Потреба наряду по (товар, склад) у базових одиницях — сума рядків. */
export function requiredByKey(
  parts: PartForRequirement[],
  coeffMap: Record<string, number>,
): Map<string, number> {
  const required = new Map<string, number>();
  for (const part of parts) {
    const key = stockKey(part.goodId, part.warehouseId);
    required.set(key, (required.get(key) ?? 0) + partBaseQty(part, coeffMap));
  }
  return required;
}

/**
 * Bug #780: нетто-резерв, який ЦЕЙ наряд реально тримає на складі, по (goodId|warehouseId).
 * reserved на StockItem — агрегат (не per-document), тож per-наряд рахуємо з його власних
 * RESERVATION/RESERVATION_RELEASE-рухів: Σ(quantity) (RESERVATION >0, RESERVATION_RELEASE <0).
 */
export async function netReservedByWorkOrder(
  db: StockDb,
  orgId: string,
  workOrderId: string,
): Promise<Map<string, number>> {
  const movements = await db.stockMovement.findMany({
    where: {
      orgId,
      documentType: 'WorkOrder',
      documentId: workOrderId,
      type: { in: ['RESERVATION', 'RESERVATION_RELEASE'] },
    },
    select: { goodId: true, warehouseId: true, quantity: true },
    take: 5000,
  });
  const net = new Map<string, number>();
  for (const m of movements) {
    const key = stockKey(m.goodId, m.warehouseId);
    net.set(key, (net.get(key) ?? 0) + m.quantity);
  }
  return net;
}

/**
 * Пакетний net-резерв кількох нарядів (BR-INVT-018): `workOrderId → (goodId|warehouseId → net)`.
 * Один `groupBy` замість запиту на наряд (нестача й розподіл при прийманні читають десятки нарядів).
 */
export async function netReservedByWorkOrders(
  db: StockDb,
  orgId: string,
  workOrderIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (workOrderIds.length === 0) return result;
  const groups = await db.stockMovement.groupBy({
    by: ['documentId', 'goodId', 'warehouseId'],
    where: {
      orgId,
      documentType: 'WorkOrder',
      documentId: { in: workOrderIds },
      type: { in: ['RESERVATION', 'RESERVATION_RELEASE'] },
    },
    _sum: { quantity: true },
  });
  for (const g of groups) {
    if (!g.documentId) continue;
    const perWo = result.get(g.documentId) ?? new Map<string, number>();
    const key = stockKey(g.goodId, g.warehouseId);
    perWo.set(key, (perWo.get(key) ?? 0) + (g._sum.quantity ?? 0));
    result.set(g.documentId, perWo);
  }
  return result;
}

/**
 * Блокує рядки нарядів (`SELECT … FOR UPDATE`) у порядку id — той самий порядок блокувань
 * «наряд → склад», що й у переходах наряду (CAS наряду, потім рухи складу). Сортування за id
 * не дає двом прийманням заблокувати ті самі наряди в різному порядку (deadlock).
 * Повертає id нарядів, що існують в організації (видалені теж блокуються — їх відсіює виклик).
 */
export async function lockWorkOrdersForUpdate(
  db: StockDb,
  orgId: string,
  workOrderIds: string[],
): Promise<string[]> {
  const ids = Array.from(new Set(workOrderIds)).sort();
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM work_orders
    WHERE "orgId" = ${orgId}::uuid AND id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE
  `;
  return rows.map(r => r.id);
}

/** Розбирає ключ `goodId|warehouseId` назад на пару. */
export function splitStockKey(key: string): [goodId: string, warehouseId: string] {
  const sep = key.indexOf('|');
  return [key.slice(0, sep), key.slice(sep + 1)];
}

/** Вільний залишок (`quantity − reserved`) товару на складі; немає рядка складу → 0. */
export async function availableQty(
  db: StockDb,
  orgId: string,
  goodId: string,
  warehouseId: string,
): Promise<number> {
  const item = await db.stockItem.findFirst({
    where: { orgId, goodId, warehouseId, deletedAt: null },
    select: { quantity: true, reserved: true },
  });
  return Math.max(0, (item?.quantity ?? 0) - (item?.reserved ?? 0));
}
