import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { BranchResponseDto, CreateBranchDto, UpdateBranchDto } from './branches.dto';
import { BranchesService } from './branches.service';

@ApiTags('Філії')
@Controller('branches')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BranchesController {
  constructor(private readonly service: BranchesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список філій' })
  @ApiResponse({ status: 200, type: [BranchResponseDto] })
  findAll(@OrgContext() orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Філія' })
  @ApiResponse({ status: 200, type: BranchResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити філію' })
  @ApiResponse({ status: 201, type: BranchResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateBranchDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити філію' })
  @ApiResponse({ status: 200, type: BranchResponseDto })
  update(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: UpdateBranchDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити філію (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }
}
