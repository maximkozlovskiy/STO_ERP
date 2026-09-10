import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  Header,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  CreateGoodStatusDto,
  GoodStatusResponseDto,
  UpdateGoodStatusDto,
} from './good-statuses.dto';
import { GoodStatusesService } from './good-statuses.service';

@ApiTags('Статуси товарів')
@Controller('good-statuses')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class GoodStatusesController {
  constructor(private readonly service: GoodStatusesService) {}

  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список статусів товарів' })
  @ApiQuery({ name: 'showDeleted', required: false, type: Boolean })
  @ApiResponse({ status: 200, type: [GoodStatusResponseDto] })
  findAll(@OrgContext() orgId: string, @Query('showDeleted') showDeleted?: string) {
    return this.service.findAll(orgId, showDeleted === 'true');
  }

  @Post(':id/restore')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Відновити видалений статус' })
  @ApiResponse({ status: 200, type: GoodStatusResponseDto })
  restore(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.restore(orgId, id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Статус товарів' })
  @ApiResponse({ status: 200, type: GoodStatusResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити статус' })
  @ApiResponse({ status: 201, type: GoodStatusResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateGoodStatusDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити статус (назва/колір)' })
  @ApiResponse({ status: 200, type: GoodStatusResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGoodStatusDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити статус (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
