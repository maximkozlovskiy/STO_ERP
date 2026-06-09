import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WorkOrdersService } from './work-orders.service';

@ApiTags('Work Orders')
@Controller('work-orders')
export class WorkOrdersPublicController {
  constructor(private readonly service: WorkOrdersService) {}

  @Get('public/:token')
  @ApiOperation({ summary: 'Публічний перегляд кошторису за share-токеном' })
  getPublicEstimate(@Param('token') token: string) {
    return this.service.findByShareToken(token);
  }
}
