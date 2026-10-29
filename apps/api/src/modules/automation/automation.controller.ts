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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AUTOMATION_RECIPIENT_ROLES,
  automationRuleSchema,
  automationRuleTestSchema,
  type AutomationRuleFormValues,
  type AutomationRuleTestValues,
} from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AutomationRulesService } from './automation-rules.service';
import { EmployeeNotificationsService } from './employee-notifications.service';
import {
  AutomationMessageListQueryDto,
  AutomationRuleEnabledDto,
  AutomationRuleFormDto,
  AutomationRuleListQueryDto,
  AutomationRuleResponseDto,
  AutomationRuleTestDto,
  AutomationRuleTestResultDto,
  AutomationRunListQueryDto,
  EmployeeNotificationListQueryDto,
  EmployeeNotificationResponseDto,
  PaginatedAutomationMessagesDto,
  PaginatedAutomationRulesDto,
  PaginatedAutomationRunsDto,
  PaginatedEmployeeNotificationsDto,
  ReadAllResultDto,
  UnreadCountDto,
} from './automation.dto';

/**
 * Правила автоматизації (docs/objects/automation.md): керують OWNER і ADMIN (BR-AUT-001, 050).
 */
@ApiTags('automation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
@Controller('automation')
export class AutomationController {
  constructor(private readonly service: AutomationRulesService) {}

  @Get('rules')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Правила автоматизації' })
  @ApiResponse({ status: 200, type: PaginatedAutomationRulesDto })
  findAll(@Query() query: AutomationRuleListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.findAll(user.orgId, query);
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити правило (невідома змінна шаблону — 400, BR-AUT-014)' })
  @ApiBody({ type: AutomationRuleFormDto })
  @ApiResponse({ status: 201, type: AutomationRuleResponseDto })
  create(
    @Body(new ZodValidationPipe(automationRuleSchema)) dto: AutomationRuleFormValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(user.orgId, user.id, dto);
  }

  @Get('runs')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Журнал спрацювань правил (BR-AUT-050)' })
  @ApiResponse({ status: 200, type: PaginatedAutomationRunsDto })
  runs(@Query() query: AutomationRunListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.runs(user.orgId, query);
  }

  @Get('messages')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Журнал повідомлень правил: кому, канал, статус доставки (BR-AUT-050)' })
  @ApiResponse({ status: 200, type: PaginatedAutomationMessagesDto })
  messages(@Query() query: AutomationMessageListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.messages(user.orgId, query);
  }

  // Специфічні суброути — перед `rules/:id` (Fastify матчить у порядку оголошення).
  @Post('rules/:id/test')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Надіслати тест собі з даними документа (BR-AUT-051)' })
  @ApiBody({ type: AutomationRuleTestDto })
  @ApiResponse({ status: 200, type: AutomationRuleTestResultDto })
  test(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(automationRuleTestSchema)) dto: AutomationRuleTestValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.test(user.orgId, user.id, id, dto.documentId);
  }

  @Patch('rules/:id/enabled')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Увімкнути / вимкнути правило (BR-AUT-006)' })
  @ApiResponse({ status: 200, type: AutomationRuleResponseDto })
  setEnabled(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AutomationRuleEnabledDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.setEnabled(user.orgId, id, dto.enabled);
  }

  @Get('rules/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Правило' })
  @ApiResponse({ status: 200, type: AutomationRuleResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.findOne(user.orgId, id);
  }

  @Patch('rules/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Змінити правило (повна форма; діє на наступні події, BR-AUT-006)' })
  @ApiBody({ type: AutomationRuleFormDto })
  @ApiResponse({ status: 200, type: AutomationRuleResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(automationRuleSchema)) dto: AutomationRuleFormValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(user.orgId, id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Видалити правило (типове — лише вимкнути, BR-AUT-007)' })
  @ApiResponse({ status: 204 })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.remove(user.orgId, id);
  }
}

/**
 * Сповіщення працівника — дзвіночок (BR-AUT-021): усі ролі персоналу, кожен — лише свої.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications/me')
export class EmployeeNotificationsController {
  constructor(private readonly service: EmployeeNotificationsService) {}

  @Get()
  @Roles(...AUTOMATION_RECIPIENT_ROLES)
  @ApiOperation({ summary: 'Мої сповіщення' })
  @ApiResponse({ status: 200, type: PaginatedEmployeeNotificationsDto })
  list(@Query() query: EmployeeNotificationListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listMine(user.orgId, user.id, query);
  }

  @Get('unread-count')
  @Roles(...AUTOMATION_RECIPIENT_ROLES)
  @ApiOperation({ summary: 'Кількість непрочитаних (опитування дзвіночка)' })
  @ApiResponse({ status: 200, type: UnreadCountDto })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.service.unreadCount(user.orgId, user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @Roles(...AUTOMATION_RECIPIENT_ROLES)
  @ApiOperation({ summary: 'Позначити всі прочитаними' })
  @ApiResponse({ status: 200, type: ReadAllResultDto })
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.service.markAllRead(user.orgId, user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @Roles(...AUTOMATION_RECIPIENT_ROLES)
  @ApiOperation({ summary: 'Позначити прочитаним' })
  @ApiResponse({ status: 200, type: EmployeeNotificationResponseDto })
  read(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.markRead(user.orgId, user.id, id);
  }
}
