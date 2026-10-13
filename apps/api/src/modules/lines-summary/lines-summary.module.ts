import { Module } from '@nestjs/common';
import { LinesSummaryService } from './lines-summary.service';

/**
 * Зведення по табличних частинах документа (BR-WO-009). Без власного контролера: endpoint
 * `GET /<документ>/:id/lines-summary` оголошує кожен модуль документа зі СВОЇМИ ролями списку.
 */
@Module({
  providers: [LinesSummaryService],
  exports: [LinesSummaryService],
})
export class LinesSummaryModule {}
