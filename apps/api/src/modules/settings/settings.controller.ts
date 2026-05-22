import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  BranchSettingsResponseDto,
  OrganisationSettingsResponseDto,
  UpdateBranchSettingsDto,
  UpdateOrganisationSettingsDto,
} from './settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Налаштування')
@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get('organisation')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Налаштування організації' })
  @ApiResponse({ status: 200, type: OrganisationSettingsResponseDto })
  getOrganisation(@OrgContext() orgId: string) {
    return this.service.getOrganisationSettings(orgId);
  }

  @Patch('organisation')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування організації' })
  @ApiResponse({ status: 200, type: OrganisationSettingsResponseDto })
  updateOrganisation(
    @OrgContext() orgId: string,
    @Body() dto: UpdateOrganisationSettingsDto,
  ) {
    return this.service.updateOrganisationSettings(orgId, dto);
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  getBranch(@OrgContext() orgId: string, @Param('branchId') branchId: string) {
    return this.service.getBranchSettings(orgId, branchId);
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  updateBranch(
    @OrgContext() orgId: string,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateBranchSettingsDto,
  ) {
    return this.service.updateBranchSettings(orgId, branchId, dto);
  }
}
