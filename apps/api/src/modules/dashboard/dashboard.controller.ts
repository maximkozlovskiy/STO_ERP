import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Поточний снапшот дашборду (для опитування — Bearer token у заголовку).
   *
   * Історія: раніше був також @Sse() GET /dashboard/stream?token= (JWT через query-param, бо EventSource
   * не дає custom headers). Фронт перейшов на polling (useDashboardStream → /dashboard/summary кожні 30с),
   * тож SSE-endpoint став мертвим кодом і видалений (tech-debt 2026-09-14): менша auth-поверхня (токен у
   * query потрапляв у access-log) + менше залежностей у контролері.
   */
  @Get('summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: 'Поточний стан дашборду' })
  getSummary(@OrgContext() orgId: string) {
    return this.dashboardService.getSummary(orgId);
  }
}
