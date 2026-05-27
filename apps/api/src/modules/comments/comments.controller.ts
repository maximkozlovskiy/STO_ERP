import {
  Controller, Get, Post, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CommentsService } from './comments.service';
import { CreateCommentDto, CommentsListResponseDto, CommentResponseDto } from './comments.dto';

@ApiTags('Comments')
@Controller('comments')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Коментарі до сутності' })
  @ApiQuery({ name: 'entityType', required: true })
  @ApiQuery({ name: 'entityId', required: true })
  findAll(
    @OrgContext() orgId: string,
    @Query('entityType') entityType: string,
    @Query('entityId', new ParseUUIDPipe()) entityId: string,
  ): Promise<CommentsListResponseDto> {
    return this.service.findAll(orgId, entityType, entityId);
  }

  @Post()
  @ApiOperation({ summary: 'Додати коментар' })
  create(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    return this.service.create(orgId, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити коментар (тільки автор або OWNER/ADMIN)' })
  remove(
    @OrgContext() orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string; role: string },
  ): Promise<void> {
    return this.service.remove(orgId, id, user);
  }
}
