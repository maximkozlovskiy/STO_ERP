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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { taskFormSchema, type TaskFormValues } from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TasksService, type TaskActor } from './tasks.service';
import {
  PaginatedTasksDto,
  TaskFormDto,
  TaskListQueryDto,
  TaskResponseDto,
  TaskTransitionDto,
} from './tasks.dto';

type User = TaskActor & { orgId: string };

/**
 * Задачі співробітникам (docs/objects/task.md). Читають і рухають статус усі ролі персоналу —
 * видимість (BR-TASK-002) і хто який перехід може (BR-TASK-003) вирішує сервіс; ставлять,
 * правлять і видаляють лише ролі керування (BR-TASK-001, `TASK_MANAGE_ROLES`).
 */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список задач (виконавець бачить лише свої)' })
  @ApiResponse({ status: 200, type: PaginatedTasksDto })
  findAll(@Query() query: TaskListQueryDto, @CurrentUser() user: User) {
    return this.service.findAll(user.orgId, user, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Поставити задачу' })
  @ApiBody({ type: TaskFormDto })
  @ApiResponse({ status: 201, type: TaskResponseDto })
  create(
    @Body(new ZodValidationPipe(taskFormSchema)) dto: TaskFormValues,
    @CurrentUser() user: User,
  ) {
    return this.service.create(user.orgId, user, dto);
  }

  // Специфічний суброут — перед `:id` (Fastify матчить у порядку оголошення).
  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Змінити статус задачі (BR-TASK-003)' })
  @ApiResponse({ status: 200, type: TaskResponseDto })
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TaskTransitionDto,
    @CurrentUser() user: User,
  ) {
    return this.service.transition(user.orgId, user, id, dto.status);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Задача' })
  @ApiResponse({ status: 200, type: TaskResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.service.findOne(user.orgId, user, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Змінити задачу (повна форма; статус — лише через transition)' })
  @ApiBody({ type: TaskFormDto })
  @ApiResponse({ status: 200, type: TaskResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(taskFormSchema)) dto: TaskFormValues,
    @CurrentUser() user: User,
  ) {
    return this.service.update(user.orgId, user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Видалити задачу (soft)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.service.remove(user.orgId, id);
  }
}
