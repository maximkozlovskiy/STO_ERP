import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarModule } from './calendar.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';

/**
 * HTTP календаря (`/calendar/slots`). Окремо від `CalendarModule`: контролер кличе
 * `WorkOrdersService` (зміна запису наряду — через наряд, BR-WO-024), а `WorkOrdersModule`
 * імпортує `CalendarModule` — в одному модулі це було б коло.
 */
@Module({
  imports: [CalendarModule, WorkOrdersModule],
  controllers: [CalendarController],
})
export class CalendarApiModule {}
