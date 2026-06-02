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
  UseGuards,
  Header,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  CreateWorkCategoryDto,
  UpdateWorkCategoryDto,
  ToggleActiveCategoryDto,
  WorkCategoryResponseDto,
} from './work-categories.dto';
import { WorkCategoriesService } from './work-categories.service';

@ApiTags('Категорії робіт')
@Controller('work-categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WorkCategoriesController {
  constructor(private readonly service: WorkCategoriesService) {}

  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Дерево категорій робіт' })
  @ApiResponse({ status: 200, type: [WorkCategoryResponseDto] })
  findAll(@OrgContext() orgId: string) {
    return this.service.findAll(orgId);
  }

  // Специфічні sub-resource роути ПЕРЕД :id — інакше Fastify матчить :id жадібно
  @Patch(':id/toggle-active')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Увімкнути/вимкнути категорію робіт' })
  toggleActive(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ToggleActiveCategoryDto,
  ) {
    return this.service.toggleActive(orgId, id, dto.isActive);
  }

  @Get(':id/linked-good-categories')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: "Пов'язані категорії товарів для категорії робіт" })
  getLinkedGoodCategories(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedGoodCategories(orgId, id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити категорію' })
  @ApiResponse({ status: 201, type: WorkCategoryResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateWorkCategoryDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkCategoryDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити категорію та всіх нащадків (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
