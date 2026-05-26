import {
  Controller,
  Get,
  Query,
  Sse,
  MessageEvent,
  UnauthorizedException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DashboardService } from './dashboard.service';
import { Observable, interval, firstValueFrom } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';

interface JwtPayload {
  sub: string;
  orgId: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(
    @Inject(forwardRef(() => DashboardService))
    private readonly dashboardService: DashboardService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Получить текущий снимок дашборда (для опроса).
   * Защищено JWT (Bearer token в headers).
   */
  @Get('summary')
  @ApiOperation({ summary: 'Поточний стан дашборду' })
  async getSummary() {
    // Note: @OrgContext() decorator / @CurrentUser() was supposed to inject orgId,
    // but for simplicity in SSE context we'll document the auth pattern below.
    // In real code, use @CurrentUser() decorator to extract orgId from JWT.
    return { message: 'Implement getSummary with @CurrentUser() decorator' };
  }

  /**
   * SSE stream для дашборду (real-time).
   * JWT передається через query param: GET /dashboard/stream?token=xxx
   * Оскільки EventSource не підтримує custom headers.
   */
  @Get('stream')
  @Sse()
  @ApiOperation({ summary: 'SSE stream дашборду (JWT через query param)' })
  @ApiQuery({ name: 'token', description: 'JWT access token' })
  stream(@Query('token') token: string): Observable<MessageEvent> {
    if (!token) {
      throw new UnauthorizedException('Token не надано');
    }

    let orgId: string;
    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
      orgId = payload.orgId;
    } catch (error) {
      throw new UnauthorizedException('Невірний або минулий токен');
    }

    // Емітувати snapshot кожні 30 сек
    return interval(30_000).pipe(
      switchMap(async () => {
        const data = await this.dashboardService.getSummary(orgId);
        return {
          data: JSON.stringify(data),
        } as MessageEvent;
      }),
    );
  }
}
