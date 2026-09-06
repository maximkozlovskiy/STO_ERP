import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, IsInt, IsIn, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationChannel } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { NotificationsService } from './notifications.service';

class UpdateTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() subject?: string;
  @ApiProperty() @IsString() body!: string;
  @ApiProperty() @IsBoolean() isActive!: boolean;
}

class VerifyProviderDto {
  @ApiProperty() @IsString() apiKey!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() senderName?: string;
}

class UpsertChannelDto {
  @ApiProperty({ enum: NotificationChannel })
  @IsIn(Object.values(NotificationChannel))
  channel!: NotificationChannel;

  @ApiProperty() @IsString() provider!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(99) priority?: number;
  // apiKey write-only: передається лише при зміні; порожнє/відсутнє → зберігаємо наявний.
  @ApiPropertyOptional() @IsOptional() @IsString() apiKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() senderName?: string;
  // ID шаблону провайдера (eSputnik Viber/Telegram). Не секрет.
  @ApiPropertyOptional() @IsOptional() @IsString() externalTemplateId?: string;
}

@ApiTags('Notifications')
@Controller('notification-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Шаблони сповіщень' })
  findAll(@OrgContext() orgId: string) {
    return this.notifications.findTemplates(orgId);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити шаблон сповіщення' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.notifications.updateTemplate(orgId, id, dto);
  }
}

@ApiTags('Notifications')
@Controller('notification-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class NotificationProvidersController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Метадані провайдерів сповіщень (code, name, channels)' })
  list() {
    return this.notifications.listProviders();
  }

  // Verify робить зовнішній HTTP-виклик до провайдера — тротлимо суворіше (5/хв),
  // щоб не перетворити на проксі для брутфорсу токенів.
  @Post(':code/verify')
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Перевірити креди провайдера (токен + баланс, без тест-SMS)' })
  verify(@Param('code') code: string, @Body() dto: VerifyProviderDto) {
    // @Param не проходить ValidationPipe → guard проти надто довгого/битого коду
    // (захист від log-pollution; далі code — лише ключ Map у registry.get).
    if (!code || code.length > 64) throw new BadRequestException('Некоректний код провайдера');
    return this.notifications.verifyProvider(code, dto.apiKey, dto.senderName);
  }
}

@ApiTags('Notifications')
@Controller('notification-channels')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class NotificationChannelsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get(':branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Канали філії (пріоритет, провайдер, hasApiKey — без ключа)' })
  list(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.notifications.getBranchChannels(orgId, branchId);
  }

  @Patch(':branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити/оновити конфіг каналу філії' })
  upsert(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpsertChannelDto,
  ) {
    return this.notifications.upsertBranchChannel(orgId, branchId, dto);
  }
}
