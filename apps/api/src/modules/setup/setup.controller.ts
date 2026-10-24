import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { Public } from '../../auth/decorators/public.decorator';
import { SetupInitDto, SetupInitResponseDto } from './setup.dto';
import { SetupService } from './setup.service';

// @Public — intentionally unauthenticated. Called before org/user exist (first-run wizard).
// Під глобальним JwtAuthGuard контролер мусить мати явний @Public(), інакше status/init
// повернули б 401. POST /init self-locks after first call via isAlreadyInitialized() check.
@ApiTags('Перший запуск')
@Public()
@Controller('setup')
export class SetupController {
  constructor(private readonly service: SetupService) {}

  @Get('status')
  @ApiOperation({ summary: 'Перевірити чи система вже налаштована' })
  @ApiResponse({ status: 200, schema: { properties: { initialized: { type: 'boolean' } } } })
  async status() {
    const initialized = await this.service.isAlreadyInitialized();
    return { initialized };
  }

  @Post('init')
  // §2.5 Hardening: публічний one-shot endpoint. isAlreadyInitialized() self-locks
  // після першого виклику, але throttle захищає від race-burst flood-у на cold start
  // (брутфорс паралельних запитів до того як перший COMMIT-нув setup).
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Ініціалізація системи (перший запуск)' })
  @ApiResponse({ status: 201, type: SetupInitResponseDto })
  @ApiResponse({ status: 403, description: 'Систему вже налаштовано' })
  async init(@Body() dto: SetupInitDto) {
    if (await this.service.isAlreadyInitialized()) {
      throw new ForbiddenException(
        translateError('err.setup.alreadyConfiguredReinit', getLocale()),
      );
    }
    return this.service.init(dto);
  }
}
