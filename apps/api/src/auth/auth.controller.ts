import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { LoginDto, AuthResponseDto } from './auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { OrgContext } from './decorators/org-context.decorator';

class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword!: string;
  @ApiProperty() @IsString() @MinLength(8) newPassword!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Поточний користувач' })
  getMe(@CurrentUser() user: { id: string }, @OrgContext() orgId: string) {
    // jwt.strategy.ts повертає { id, orgId, role } — `sub` поле НЕ існує у runtime user.
    return this.authService.getMe(orgId, user.id);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Змінити пароль' })
  changePassword(
    @CurrentUser() user: { id: string },
    @OrgContext() orgId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(orgId, user.id, dto.currentPassword, dto.newPassword);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вхід у систему' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Невірний email або пароль' })
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AuthResponseDto> {
    return this.authService.login(dto, res);
  }

  @Post('refresh')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('sto_refresh')
  @ApiOperation({ summary: 'Оновити access token через refresh cookie' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  refresh(
    @Req() req: FastifyRequest & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AuthResponseDto> {
    const refreshToken = req.cookies?.sto_refresh ?? '';
    return this.authService.refresh(refreshToken, res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Вийти з системи' })
  @ApiResponse({ status: 204 })
  logout(@Res({ passthrough: true }) res: FastifyReply): void {
    this.authService.logout(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Вийти на всіх пристроях (інвалідувати всі сесії)' })
  @ApiResponse({ status: 204 })
  logoutAll(
    @CurrentUser() user: { id: string },
    @OrgContext() orgId: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    return this.authService.logoutAll(orgId, user.id, res);
  }
}
