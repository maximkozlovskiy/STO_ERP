import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { UserRole } from '@prisma/client';
import { CompletionActsService } from './completion-acts.service';
import { CompletionActResponseDto, SignCompletionActDto } from './completion-acts.dto';

@ApiTags('Completion Acts')
@Controller('completion-acts')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CompletionActsController {
  constructor(private readonly service: CompletionActsService) {}

  @Get()
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER, UserRole.ACCOUNTANT)
  @ApiResponse({ status: 200, type: [CompletionActResponseDto] })
  findAll(@OrgContext() orgId: string, @Query('workOrderId') workOrderId?: string) {
    return this.service.findAll(orgId, workOrderId);
  }

  @Get(':id')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER, UserRole.ACCOUNTANT)
  @ApiResponse({ status: 200, type: CompletionActResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post('from-work-order/:workOrderId')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Generate completion act from work order' })
  @ApiResponse({ status: 201, type: CompletionActResponseDto })
  createFromWorkOrder(@OrgContext() orgId: string, @Param('workOrderId', ParseUUIDPipe) workOrderId: string) {
    return this.service.createFromWorkOrder(orgId, workOrderId);
  }

  @Patch(':id/sign')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Sign completion act → transitions WO to INVOICED and generates Invoice' })
  @ApiResponse({ status: 200, type: CompletionActResponseDto })
  sign(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignCompletionActDto,
  ) {
    return this.service.sign(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Cancel completion act (DRAFT only)' })
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }
}
