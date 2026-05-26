import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto';

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити вебхук' })
  create(
    @Body() dto: CreateWebhookDto,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.create(user.orgId, dto);
  }

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Список вебхуків' })
  findAll(@CurrentUser() user: { orgId: string }) {
    return this.service.findAll(user.orgId);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити вебхук' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.update(user.orgId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Видалити вебхук' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.remove(user.orgId, id);
  }

  @Get(':id/deliveries')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Лог доставки вебхука' })
  findDeliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.findDeliveries(user.orgId, id);
  }
}
