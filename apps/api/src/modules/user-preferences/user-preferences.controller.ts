import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { UpsertUserPreferenceDto, UserPreferenceResponseDto } from './user-preferences.dto';
import { UserPreferencesService } from './user-preferences.service';

@ApiTags('Налаштування користувача')
@Controller('user-preferences')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class UserPreferencesController {
  constructor(private readonly service: UserPreferencesService) {}

  @Get(':key')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT', 'STOREKEEPER')
  @ApiOperation({ summary: 'Отримати налаштування панелі' })
  async get(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
  ): Promise<UserPreferenceResponseDto> {
    const value = await this.service.get(orgId, user.id, key);
    return { key, value: value ?? {} };
  }

  @Put(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT', 'STOREKEEPER')
  @ApiOperation({ summary: 'Зберегти налаштування панелі' })
  async upsert(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpsertUserPreferenceDto,
  ): Promise<void> {
    await this.service.upsert(orgId, user.id, key, dto.value as Record<string, unknown>);
  }
}
