import {
  Controller,
  Get,
  Query,
  Sse,
  MessageEvent,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DashboardService } from './dashboard.service';
import { Observable, interval, startWith } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';

interface JwtPayload {
  sub: string;
  orgId: string;
}

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Поточний снапшот дашборду (для опитування — Bearer token у заголовку).
   */
  @Get('summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: 'Поточний стан дашборду' })
  getSummary(@OrgContext() orgId: string) {
    return this.dashboardService.getSummary(orgId);
  }

  /**
   * SSE stream для дашборду (real-time).
   * JWT передається через query param: GET /dashboard/stream?token=xxx
   * Оскільки EventSource не підтримує custom headers.
   * Verify токену відбувається вручну тут — на цей endpoint @UseGuards не вішається,
   * бо JwtAuthGuard очікує Bearer header.
   */
  @Get('stream')
  @Sse()
  // SSE: дозволяємо лише 5 нових з'єднань на хвилину з однієї IP.
  // Це не обмежує вже відкриті long-lived з'єднання — тільки нові підключення,
  // що захищає від reconnect-storm (browser tab spawn, broken proxies).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'SSE stream дашборду (JWT через query param)' })
  @ApiQuery({ name: 'token', description: 'JWT access token' })
  stream(@Query('token') token: string): Observable<MessageEvent> {
    if (!token) {
      throw new UnauthorizedException('Token не надано');
    }

    let orgId: string;
    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      if (!payload.orgId || !payload.sub) {
        throw new UnauthorizedException('Невірний токен (відсутні claims)');
      }
      orgId = payload.orgId;
    } catch {
      throw new UnauthorizedException('Невірний або минулий токен');
    }

    // Емітувати snapshot одразу при підключенні + кожні 30 сек.
    return interval(30_000).pipe(
      startWith(0),
      switchMap(async () => {
        const data = await this.dashboardService.getSummary(orgId);
        return { data: JSON.stringify(data) };
      }),
    );
  }
}
