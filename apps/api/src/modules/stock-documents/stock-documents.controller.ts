import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { StockDocumentsService } from './stock-documents.service';
import {
  CreateStockDocumentDto, UpdateStockDocumentDto, TransitionStockDocumentDto,
} from './stock-documents.dto';

@ApiTags('Stock Documents')
@Controller('stock-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StockDocumentsController {
  constructor(private readonly service: StockDocumentsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Список складських документів' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'] })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'CONFIRMED', 'CANCELLED'] })
  findAll(
    @OrgContext() orgId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    return this.service.findAll(orgId, +page, +limit, type, status);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Складський документ по ID' })
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Створити складський документ' })
  create(@OrgContext() orgId: string, @Body() dto: CreateStockDocumentDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити чернетку документа' })
  update(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateStockDocumentDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку документа' })
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Змінити статус документа (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: TransitionStockDocumentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.transition(orgId, id, dto.status as any, user?.sub);
  }
}
