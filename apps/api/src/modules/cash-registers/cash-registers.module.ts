import { Module } from '@nestjs/common';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegistersService } from './cash-registers.service';
import { CashDeskService } from './cash-desk.service';
import { CashModule } from '../cash/cash.module';
import { PaymentsModule } from '../payments/payments.module';
import { SupplierPaymentsModule } from '../supplier-payments/supplier-payments.module';
import { SettlementsModule } from '../settlements/settlements.module';

@Module({
  imports: [
    CashModule, // CashService: баланс + рух готівки (операції)
    // Каса як місце готівкових оплат (CashDeskService): оплата контрагента й оплата постачальнику
    // створюються їхніми сервісами, повернення — проводкою взаєморозрахунків. Циклу немає: жоден
    // із цих модулів (і їхні імпорти) не імпортує CashRegistersModule.
    PaymentsModule,
    SupplierPaymentsModule,
    SettlementsModule,
  ],
  controllers: [CashRegistersController],
  providers: [CashRegistersService, CashDeskService],
  exports: [CashRegistersService],
})
export class CashRegistersModule {}
