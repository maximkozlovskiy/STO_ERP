import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CashRegistersService } from './cash-registers.service';
import { CreateCashRegisterDto, UpdateCashRegisterDto } from './cash-registers.dto';

@ApiTags('Каса')
@Controller('cash-registers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CashRegistersController {
  constructor(private readonly service: CashRegistersService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список кас' })
  @ApiQuery({ name: 'branchId', required: false })
  findAll(@OrgContext() orgId: string, @Query('branchId') branchId?: string) {
    return this.service.findAll(orgId, branchId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Каса' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити касу' })
  create(@OrgContext() orgId: string, @Body() dto: CreateCashRegisterDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити касу' })
  update(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCashRegisterDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити касу (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
