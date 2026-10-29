import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBooleanString,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { TaskStatus, WorkOrderPriority } from '@prisma/client';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from '@sto/shared';
import { LimitParam, PageParam, SortDirParam } from '../../common/dto/list-query.decorators';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';
import { LIST_SEARCH_MAX_LENGTH } from '../../common/utils/like-pattern';

/**
 * Тіло `POST /tasks` і `PATCH /tasks/:id` — лише для Swagger. Перевіряє спільна zod-схема
 * `taskFormSchema` (`ZodValidationPipe`), та сама, що у формі web. PATCH — повна форма: не
 * передане необов'язкове поле означає «порожньо» і стирає збережене значення.
 */
export class TaskFormDto {
  @ApiProperty({ maxLength: TASK_TITLE_MAX }) title!: string;
  @ApiPropertyOptional({ maxLength: TASK_DESCRIPTION_MAX }) description?: string;
  @ApiProperty({ format: 'uuid' }) assigneeId!: string;
  @ApiPropertyOptional({ enum: WorkOrderPriority, default: 'NORMAL' })
  priority?: WorkOrderPriority;
  @ApiPropertyOptional({ description: 'Початок — мітка часу ISO' }) startAt?: string;
  @ApiPropertyOptional({ description: 'Термін — мітка часу ISO' }) dueAt?: string;
  @ApiPropertyOptional({ format: 'uuid' }) workOrderId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) vehicleId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) counterpartyId?: string;
}

export class TaskTransitionDto {
  @ApiProperty({ enum: TaskStatus })
  @IsEnum(TaskStatus)
  status!: TaskStatus;
}

/** `completedAt` — щойно виконані першими (`desc`): планшет механіка тримає останні виконані. */
export const TASK_SORT_FIELDS = [
  'dueAt',
  'startAt',
  'priority',
  'createdAt',
  'completedAt',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

/** Повторений параметр (`?status=A&status=B`) Fastify віддає масивом; `A,B` — розбираємо теж. */
const csvList = ({ value }: { value: unknown }): unknown => {
  const list: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  const parts = list
    .flatMap((v): unknown[] => (typeof v === 'string' ? v.split(',') : [v]))
    .map(v => (typeof v === 'string' ? v.trim() : v))
    .filter(v => v !== '' && v != null);
  return parts.length > 0 ? parts : undefined;
};

/** `GET /tasks` (BR-TASK-002, 004, 005). */
export class TaskListQueryDto {
  @ApiPropertyOptional({ description: 'Пошук за назвою' })
  @IsOptional()
  @IsString()
  @MaxLength(LIST_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({
    description: 'Статуси через кому',
    type: String,
    example: 'NEW,IN_PROGRESS',
  })
  @IsOptional()
  @Transform(csvList)
  @IsArray()
  @ArrayMaxSize(Object.keys(TaskStatus).length)
  @IsEnum(TaskStatus, { each: true })
  status?: TaskStatus[];

  @ApiPropertyOptional({
    description: 'Пріоритети через кому',
    type: String,
    example: 'HIGH,URGENT',
  })
  @IsOptional()
  @Transform(csvList)
  @IsArray()
  @ArrayMaxSize(Object.keys(WorkOrderPriority).length)
  @IsEnum(WorkOrderPriority, { each: true })
  priority?: WorkOrderPriority[];

  @ApiPropertyOptional({ description: 'Виконавець' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Лише мої задачі (true / 1)' })
  @IsOptional()
  @IsBooleanString()
  mine?: string;

  @ApiPropertyOptional({ description: 'Лише прострочені (BR-TASK-005)' })
  @IsOptional()
  @IsBooleanString()
  overdue?: string;

  @ApiPropertyOptional({
    description:
      'Від (YYYY-MM-DD, день за Києвом): задачі, чий проміжок [початок ?? термін, термін ?? початок] ' +
      'перетинає [from, to]. Задачі без обох дат у відбір за датами не потрапляють.',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'До (YYYY-MM-DD, включно, день за Києвом)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    description:
      'Список (не календар) з періодом: додати відкриті задачі (NEW / IN_PROGRESS) без дат або з ' +
      'датами, що скінчились до `from` (BR-TASK-009). Без `from`/`to` нічого не змінює.',
  })
  @IsOptional()
  @IsBooleanString()
  includeOpen?: string;

  @ApiPropertyOptional({ description: "Задачі наряду (секція «Пов'язані документи»)" })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string;

  @ApiPropertyOptional({ description: 'Лише ця задача (посилання)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    enum: TASK_SORT_FIELDS,
    description: 'Типово — dueAt; dueAt / startAt / completedAt — порожні в кінці',
  })
  @IsOptional()
  @IsIn(TASK_SORT_FIELDS)
  sortBy?: TaskSortField;

  @SortDirParam('Типово — asc')
  sortDir?: 'asc' | 'desc';

  @PageParam()
  page: number = 1;

  @LimitParam(20)
  limit: number = 20;
}

export class TaskResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: TaskStatus }) status!: TaskStatus;
  @ApiProperty({ enum: WorkOrderPriority }) priority!: WorkOrderPriority;
  @ApiProperty() assigneeId!: string;
  @ApiProperty() assigneeName!: string;
  // null — задачу створило правило автоматизації (BR-AUT-031).
  @ApiProperty({ type: String, nullable: true }) createdById!: string | null;
  @ApiProperty() createdByName!: string;
  @ApiProperty({ type: String, nullable: true }) startAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) dueAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) workOrderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) workOrderNumber!: string | null;
  @ApiProperty({ description: 'Наряд прив’язки видалено після постановки задачі (BR-TASK-006)' })
  workOrderDeleted!: boolean;
  @ApiProperty({ type: String, nullable: true }) vehicleId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Марка, модель, номер' })
  vehicleSummary!: string | null;
  @ApiProperty({ type: String, nullable: true }) counterpartyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) counterpartyName!: string | null;
  @ApiProperty({ description: 'Термін минув, задача не виконана й не скасована (BR-TASK-005)' })
  overdue!: boolean;
  @ApiProperty() syncVersion!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedTasksDto {
  @ApiProperty({ type: [TaskResponseDto] }) items!: TaskResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
