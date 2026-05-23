import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SetupInitDto, SetupInitResponseDto } from './setup.dto';
import { SetupService } from './setup.service';

@ApiTags('Перший запуск')
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
  @ApiOperation({ summary: 'Ініціалізація системи (перший запуск)' })
  @ApiResponse({ status: 201, type: SetupInitResponseDto })
  @ApiResponse({ status: 403, description: 'Систему вже налаштовано' })
  async init(@Body() dto: SetupInitDto) {
    if (await this.service.isAlreadyInitialized()) {
      throw new ForbiddenException('Систему вже налаштовано. Повторна ініціалізація заборонена.');
    }
    return this.service.init(dto);
  }
}
