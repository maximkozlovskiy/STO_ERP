import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsBooleanString,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  AutomationDocumentType,
  AutomationEventKind,
  AutomationMessageKind,
  AutomationRunStatus,
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { LimitParam, PageParam } from '../../common/dto/list-query.decorators';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';

/**
 * Тіло `POST /automation/rules` і `PATCH /automation/rules/:id` — лише для Swagger. Перевіряє
 * спільна zod-схема `automationRuleSchema` (`@sto/shared`): умови й дії — її типи. PATCH — повна
 * форма правила.
 */
export class AutomationRuleFormDto {
  @ApiProperty({ maxLength: 200 }) name!: string;
  @ApiPropertyOptional({ default: true }) enabled?: boolean;
  @ApiProperty({ enum: AutomationDocumentType }) documentType!: AutomationDocumentType;
  @ApiProperty({ enum: AutomationEventKind }) eventKind!: AutomationEventKind;
  @ApiPropertyOptional({ type: [String], description: 'У статус (порожньо — будь-який)' })
  toStatuses?: string[];
  @ApiPropertyOptional({ enum: AutomationMessageKind, default: 'SERVICE' })
  messageKind?: AutomationMessageKind;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'branchIds, fromStatuses, repairCategories, priorities, minAmount — «І»',
  })
  conditions?: Record<string, unknown>;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'client_message / employee_notification / create_task',
  })
  actions!: Record<string, unknown>[];
}

export class AutomationRuleEnabledDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}

export class AutomationRuleTestDto {
  @ApiProperty({ format: 'uuid', description: 'Документ, дані якого підставляються в шаблони' })
  documentId!: string;
}

export class AutomationRuleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: AutomationDocumentType }) documentType!: AutomationDocumentType;
  @ApiProperty({ enum: AutomationEventKind }) eventKind!: AutomationEventKind;
  @ApiProperty({ type: [String] }) toStatuses!: string[];
  @ApiProperty({ enum: AutomationMessageKind }) messageKind!: AutomationMessageKind;
  @ApiProperty({ type: 'object', additionalProperties: true }) conditions!: Record<string, unknown>;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  actions!: Record<string, unknown>[];
  @ApiProperty({ type: String, nullable: true, description: 'Типове правило (BR-AUT-007)' })
  systemKey!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Останнє спрацювання' })
  lastRunAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedAutomationRulesDto {
  @ApiProperty({ type: [AutomationRuleResponseDto] }) items!: AutomationRuleResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class AutomationRuleListQueryDto {
  @ApiPropertyOptional({ enum: AutomationDocumentType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AutomationDocumentType)
  documentType?: AutomationDocumentType;

  @ApiPropertyOptional({ description: 'Лише увімкнені (true) / вимкнені (false)' })
  @IsOptional()
  @IsBooleanString()
  enabled?: string;

  @PageParam()
  page: number = 1;

  @LimitParam(50)
  limit: number = 50;
}

/** Фільтри журналу: правило, документ, з дня / по день (Київ). */
class AutomationJournalQueryBase {
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() ruleId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() documentId?: string;

  @ApiPropertyOptional({ enum: AutomationDocumentType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AutomationDocumentType)
  documentType?: AutomationDocumentType;

  @ApiPropertyOptional({ description: 'З дня (YYYY-MM-DD, Київ)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'По день (YYYY-MM-DD, включно, Київ)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  to?: string;

  @PageParam()
  page: number = 1;

  @LimitParam(50)
  limit: number = 50;
}

export class AutomationRunListQueryDto extends AutomationJournalQueryBase {
  @ApiPropertyOptional({ enum: AutomationRunStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AutomationRunStatus)
  status?: AutomationRunStatus;
}

export class AutomationMessageListQueryDto extends AutomationJournalQueryBase {
  @ApiPropertyOptional({ enum: NotificationDeliveryStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(NotificationDeliveryStatus)
  status?: NotificationDeliveryStatus;

  @ApiPropertyOptional({ description: 'Лише тестові (true) / лише справжні (false)' })
  @IsOptional()
  @IsBooleanString()
  isTest?: string;
}

export class AutomationActionResultDto {
  @ApiProperty() index!: number;
  @ApiProperty({ enum: ['client_message', 'employee_notification', 'create_task'] }) type!: string;
  @ApiProperty({ enum: ['DONE', 'SKIPPED', 'FAILED'] }) status!: string;
  @ApiPropertyOptional({ description: 'Причина пропуску (AUTOMATION_SKIP_REASONS)' })
  reason?: string;
  @ApiPropertyOptional() error?: string;
  @ApiPropertyOptional({ type: [String] }) channels?: string[];
  @ApiPropertyOptional() delayedUntil?: string;
  @ApiPropertyOptional() recipients?: number;
  @ApiPropertyOptional() taskId?: string;
}

export class AutomationRunResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ruleId!: string;
  @ApiProperty() ruleName!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ enum: AutomationDocumentType }) documentType!: AutomationDocumentType;
  @ApiProperty() documentId!: string;
  @ApiProperty({ enum: AutomationEventKind }) eventKind!: AutomationEventKind;
  @ApiProperty({ type: String, nullable: true }) fromStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) toStatus!: string | null;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ enum: AutomationRunStatus }) status!: AutomationRunStatus;
  @ApiProperty({ type: [AutomationActionResultDto] }) actionResults!: AutomationActionResultDto[];
  @ApiProperty() createdAt!: string;
}

export class PaginatedAutomationRunsDto {
  @ApiProperty({ type: [AutomationRunResponseDto] }) items!: AutomationRunResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class AutomationMessageResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) ruleId!: string | null;
  @ApiProperty({ enum: AutomationDocumentType, nullable: true })
  documentType!: AutomationDocumentType | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) counterpartyId!: string | null;
  @ApiProperty({ enum: NotificationChannel }) channel!: NotificationChannel;
  @ApiProperty() provider!: string;
  @ApiProperty({ description: 'Одержувач: телефон або email' }) recipient!: string;
  @ApiProperty({ enum: NotificationDeliveryStatus }) status!: NotificationDeliveryStatus;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: String, nullable: true }) skipReason!: string | null;
  @ApiProperty() isTest!: boolean;
  @ApiProperty() attempt!: number;
  @ApiProperty() createdAt!: string;
}

export class PaginatedAutomationMessagesDto {
  @ApiProperty({ type: [AutomationMessageResponseDto] }) items!: AutomationMessageResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class AutomationRuleTestResultDto {
  @ApiProperty({ type: [AutomationActionResultDto] }) actionResults!: AutomationActionResultDto[];
}

// ─── Сповіщення працівника (дзвіночок, BR-AUT-021) ─────────────────────────────────────────

export class EmployeeNotificationListQueryDto {
  @ApiPropertyOptional({ description: 'Лише непрочитані (true / 1)' })
  @IsOptional()
  @IsBooleanString()
  unread?: string;

  @PageParam()
  page: number = 1;

  @LimitParam(20, 100)
  limit: number = 20;
}

export class EmployeeNotificationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) body!: string | null;
  @ApiProperty({ enum: AutomationDocumentType, nullable: true })
  documentType!: AutomationDocumentType | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) readAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class PaginatedEmployeeNotificationsDto {
  @ApiProperty({ type: [EmployeeNotificationResponseDto] })
  items!: EmployeeNotificationResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class UnreadCountDto {
  @ApiProperty() count!: number;
}

export class ReadAllResultDto {
  @ApiProperty({ description: 'Скільки позначено прочитаними' }) updated!: number;
}
