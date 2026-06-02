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
  CreateGoodCategoryDto,
  UpdateGoodCategoryDto,
  ToggleActiveDto,
  GoodCategoryResponseDto,
} from './good-categories.dto';
import { GoodCategoriesService } from './good-categories.service';

@ApiTags('Категорії товарів')
@Controller('good-categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class GoodCategoriesController {
  constructor(private readonly service: GoodCategoriesService) {}

  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: 'Дерево категорій товарів' })
  @ApiResponse({ status: 200, type: [GoodCategoryResponseDto] })
  findAll(@OrgContext() orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Get(':id/linked-work-categories')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: "Пов'язані категорії робіт для категорії товарів" })
  getLinkedWorkCategories(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedWorkCategories(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити категорію товарів' })
  @ApiResponse({ status: 201, type: GoodCategoryResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateGoodCategoryDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGoodCategoryDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Patch(':id/toggle-active')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Увімкнути/вимкнути категорію' })
  toggleActive(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ToggleActiveDto,
  ) {
    return this.service.toggleActive(orgId, id, dto.isActive);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити категорію та нащадків (soft delete), товари → без категорії' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
