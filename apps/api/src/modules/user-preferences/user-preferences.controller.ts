import {
  BadRequestException,
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

const KEY_MAX_LENGTH = 200;

/**
 * Захист від занадто довгого / порожнього path-параметра :key.
 * DTO `key` валідується через @MaxLength(200), але @Param('key') не проходить ValidationPipe →
 * без власного guard користувач міг би слати багатокілобайтовий рядок у URL.
 */
function ensureValidKey(key: string): void {
  if (!key || key.length === 0) {
    throw new BadRequestException('Ключ не може бути порожнім');
  }
  if (key.length > KEY_MAX_LENGTH) {
    throw new BadRequestException(`Ключ занадто довгий (максимум ${KEY_MAX_LENGTH} символів)`);
  }
}

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
    ensureValidKey(key);
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
    ensureValidKey(key);
    // Path-параметр :key — джерело істини; body.key зберігається лише для контракту GET-відповіді.
    // Якщо клієнт надсилає неузгоджені значення — відмовляємо, щоб не плутати їх з різними записами.
    if (dto.key && dto.key !== key) {
      throw new BadRequestException('Ключ у URL та тілі запиту мають збігатися');
    }
    await this.service.upsert(orgId, user.id, key, dto.value);
  }
}
