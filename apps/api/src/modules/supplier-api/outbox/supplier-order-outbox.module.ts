import { Module } from '@nestjs/common';
import { SupplierOrderOutboxService } from './supplier-order-outbox.service';

/**
 * Листковий модуль outbox передачі замовлень у API постачальника (BR-SCON-009, 014). Імпортує
 * його PurchaseOrdersModule; сам він нічого з модулів застосунку не імпортує (Prisma й
 * EventEmitter2 — глобальні), тож циклу PurchaseOrders ↔ SupplierApi немає.
 */
@Module({
  providers: [SupplierOrderOutboxService],
  exports: [SupplierOrderOutboxService],
})
export class SupplierOrderOutboxModule {}
