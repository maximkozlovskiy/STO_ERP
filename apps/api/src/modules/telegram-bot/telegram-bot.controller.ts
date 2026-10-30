import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { TelegramSubscriptionStatusDto } from '../notifications/telegram-subscription.dto';
import { ConnectTelegramBotDto, TelegramBotStatusDto, TelegramLinkDto } from './telegram-bot.dto';
import { TelegramBotService } from './telegram-bot.service';

/** Усі ролі персоналу: підписатися на бот може кожен працівник (BR-AUT-041). */
const STAFF_ROLES = [
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'MECHANIC',
  'STOREKEEPER',
  'ACCOUNTANT',
  'XLSX_MANAGER',
] as const;

@ApiTags('Telegram-бот')
@Controller('settings/telegram-bot')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TelegramBotSettingsController {
  constructor(private readonly bot: TelegramBotService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Стан власного Telegram-бота (токен не віддається)' })
  @ApiResponse({ status: 200, type: TelegramBotStatusDto })
  status(@CurrentUser() user: AuthenticatedUser): Promise<TelegramBotStatusDto> {
    return this.bot.status(user.orgId);
  }

  // Зовнішній виклик getMe — тротлимо суворіше (як перевірку провайдера сповіщень).
  @Put()
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Підключити бота: перевірка getMe, токен зберігається зашифрованим' })
  @ApiResponse({ status: 200, type: TelegramBotStatusDto })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConnectTelegramBotDto,
  ): Promise<TelegramBotStatusDto> {
    return this.bot.connect(user.orgId, dto.token, user.id);
  }

  @Delete()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Відключити бота (опитування зупиняється)' })
  @ApiResponse({ status: 200, type: TelegramBotStatusDto })
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<TelegramBotStatusDto> {
    return this.bot.disconnect(user.orgId, user.id);
  }
}

@ApiTags('Telegram-бот')
@Controller('counterparties')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CounterpartyTelegramController {
  constructor(private readonly bot: TelegramBotService) {}

  @Post(':id/telegram-link')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Посилання підписки клієнта на бот (одноразовий код, 7 днів)' })
  @ApiResponse({ status: 201, type: TelegramLinkDto })
  createLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelegramLinkDto> {
    return this.bot.createLink(user.orgId, { kind: 'counterparty', id }, user.id);
  }

  @Delete(':id/telegram-subscription')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Відписати клієнта від бота' })
  @ApiResponse({ status: 200, type: TelegramSubscriptionStatusDto })
  unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelegramSubscriptionStatusDto> {
    return this.bot.unsubscribe(user.orgId, { kind: 'counterparty', id });
  }
}

@ApiTags('Telegram-бот')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EmployeeTelegramController {
  constructor(private readonly bot: TelegramBotService) {}

  // `me/*` — перед `:id/*`: свій профіль, будь-яка роль персоналу.
  @Post('me/telegram-link')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Посилання підписки на бот для себе' })
  @ApiResponse({ status: 201, type: TelegramLinkDto })
  createMyLink(@CurrentUser() user: AuthenticatedUser): Promise<TelegramLinkDto> {
    return this.bot.createLink(user.orgId, { kind: 'employee', id: user.id }, user.id);
  }

  @Get('me/telegram-subscription')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Моя підписка на бот' })
  @ApiResponse({ status: 200, type: TelegramSubscriptionStatusDto })
  mySubscription(@CurrentUser() user: AuthenticatedUser): Promise<TelegramSubscriptionStatusDto> {
    return this.bot.subscription(user.orgId, { kind: 'employee', id: user.id });
  }

  @Delete('me/telegram-subscription')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Відписатися від бота' })
  @ApiResponse({ status: 200, type: TelegramSubscriptionStatusDto })
  unsubscribeMe(@CurrentUser() user: AuthenticatedUser): Promise<TelegramSubscriptionStatusDto> {
    return this.bot.unsubscribe(user.orgId, { kind: 'employee', id: user.id });
  }

  @Post(':id/telegram-link')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Посилання підписки працівника на бот' })
  @ApiResponse({ status: 201, type: TelegramLinkDto })
  createLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelegramLinkDto> {
    return this.bot.createLink(user.orgId, { kind: 'employee', id }, user.id);
  }

  @Delete(':id/telegram-subscription')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Відписати працівника від бота' })
  @ApiResponse({ status: 200, type: TelegramSubscriptionStatusDto })
  unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelegramSubscriptionStatusDto> {
    return this.bot.unsubscribe(user.orgId, { kind: 'employee', id });
  }
}
