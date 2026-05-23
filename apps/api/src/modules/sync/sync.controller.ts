import {
  Controller, Get, Post, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { SyncService, SyncRecord } from './sync.service';

class PushDto {
  @IsArray() records!: SyncRecord[];
}

@ApiTags('Sync')
@Controller('sync')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Get('status')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Статус синхронізації' })
  getStatus(@OrgContext() orgId: string) {
    return this.service.getStatus(orgId);
  }

  @Get('pull')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Pull changes since syncVersion' })
  @ApiQuery({ name: 'since', required: false, type: Number })
  pull(
    @OrgContext() orgId: string,
    @Query('since') since?: string,
  ) {
    const sinceVersion = since ? BigInt(since) : BigInt(0);
    return this.service.pull(orgId, sinceVersion);
  }

  @Post('push')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Push local changes to server' })
  push(
    @OrgContext() orgId: string,
    @Body() dto: PushDto,
  ) {
    return this.service.push(orgId, dto.records);
  }
}
