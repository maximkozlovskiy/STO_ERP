import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';

/**
 * Сервіс календаря без HTTP: його імпортують наряди (BR-WO-019/020) і онлайн-запис. Контролер —
 * у `CalendarApiModule`, бо зміну запису наряду проводить `WorkOrdersService` (BR-WO-024), а
 * наряди самі імпортують цей модуль.
 */
@Module({
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
