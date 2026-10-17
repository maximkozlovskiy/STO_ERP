import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { moneyFromDecimal } from '../../common/utils/money';
import {
  PurchaseOrdersService,
  type PreparedPurchaseOrder,
} from '../purchase-orders/purchase-orders.service';
import { conflict, err } from './purchase-lists.helpers';
import type { CreateOrdersResultDto } from './purchase-lists.dto';

interface OrderGroup {
  supplierId: string;
  warehouseId: string;
  itemIds: string[];
  /** `goodId|ціна` → рядок замовлення з сумою кількостей позицій. */
  lines: Map<string, { goodId: string; price: number; quantity: number }>;
}

/**
 * BR-PL-008: замовлення постачальникам із позицій списків купівлі. Позиції групуються за
 * (постачальник, склад) — одне DRAFT-замовлення на групу; рядок — на (товар, ціна) із сумою
 * кількостей; ціна = `expectedPrice ?? Good.purchasePrice ?? 0`. Перевірки й номери — ДО
 * транзакції (`PurchaseOrdersService.prepareCreate`); замовлення (`createInTx`) і перехід позицій
 * у ORDERED (CAS на OPEN без замовлення) — в одній транзакції.
 */
@Injectable()
export class PurchaseListOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  async createOrders(orgId: string, itemIds: string[]): Promise<CreateOrdersResultDto> {
    const ids = Array.from(new Set(itemIds));
    const items = await this.prisma.purchaseListItem.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null },
      include: { good: { select: { name: true, purchasePrice: true } } },
      orderBy: { createdAt: 'asc' },
      take: ids.length,
    });
    if (items.length !== ids.length) {
      const found = new Set(items.map(i => i.id));
      throw new NotFoundException(
        err('err.purchaseList.itemsNotFound', {
          missing: ids.filter(i => !found.has(i)).join(', '),
        }),
      );
    }
    if (items.some(i => i.status !== 'OPEN' || i.purchaseOrderId !== null)) {
      throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    }
    const noSupplier = items.filter(i => !i.supplierId);
    if (noSupplier.length > 0) {
      throw new BadRequestException(
        err('err.purchaseList.supplierRequired', {
          goods: Array.from(new Set(noSupplier.map(i => i.good.name))).join(', '),
        }),
      );
    }

    const groups = new Map<string, OrderGroup>();
    for (const item of items) {
      const supplierId = item.supplierId as string;
      const key = `${supplierId}|${item.warehouseId}`;
      const group: OrderGroup = groups.get(key) ?? {
        supplierId,
        warehouseId: item.warehouseId,
        itemIds: [],
        lines: new Map(),
      };
      const price = moneyFromDecimal(item.expectedPrice ?? item.good.purchasePrice ?? 0);
      const lineKey = `${item.goodId}|${price}`;
      const line = group.lines.get(lineKey) ?? { goodId: item.goodId, price, quantity: 0 };
      line.quantity += item.quantity;
      group.lines.set(lineKey, line);
      group.itemIds.push(item.id);
      groups.set(key, group);
    }

    // Перевірки (постачальник BR-CP-001, склад, товари), номери, ПДВ і курс — до транзакції.
    const prepared: Array<{ group: OrderGroup; po: PreparedPurchaseOrder }> = [];
    for (const group of groups.values()) {
      const po = await this.purchaseOrders.prepareCreate(orgId, {
        supplierId: group.supplierId,
        warehouseId: group.warehouseId,
        lines: Array.from(group.lines.values()),
      });
      prepared.push({ group, po });
    }

    const orders = await this.prisma.$transaction(
      async tx => {
        const created: CreateOrdersResultDto['orders'] = [];
        for (const { group, po } of prepared) {
          const order = await this.purchaseOrders.createInTx(tx, orgId, po);
          const res = await tx.purchaseListItem.updateMany({
            where: {
              orgId,
              id: { in: group.itemIds },
              status: 'OPEN',
              purchaseOrderId: null,
              deletedAt: null,
            },
            data: { status: 'ORDERED', purchaseOrderId: order.id },
          });
          if (res.count !== group.itemIds.length) throw conflict();
          created.push({
            id: order.id,
            number: order.number,
            supplierId: group.supplierId,
            warehouseId: group.warehouseId,
            itemsCount: group.itemIds.length,
          });
        }
        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return { orders };
  }
}
