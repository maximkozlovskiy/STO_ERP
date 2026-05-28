import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { ExchangeRatesService } from './exchange-rates.service';
import { CreateExchangeRateDto, UpdateExchangeRateDto } from './exchange-rates.dto';

@ApiTags('Курси валют')
@Controller('exchange-rates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ExchangeRatesController {
  constructor(private readonly service: ExchangeRatesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'STOREKEEPER', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список курсів валют' })
  @ApiQuery({ name: 'currencyId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('currencyId') currencyId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.findAll(orgId, { currencyId, from, to });
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Курс валюти' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Додати курс' })
  create(@OrgContext() orgId: string, @Body() dto: CreateExchangeRateDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити курс' })
  update(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExchangeRateDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити курс (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
