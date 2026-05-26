import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

@Injectable()
export class BranchAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      params?: Record<string, string>;
      query?: Record<string, string>;
    }>();
    const user = request.user;
    if (!user) return false;

    // OWNER and ADMIN with allBranches flag bypass check
    if (user.role === 'OWNER' || user.role === 'ADMIN') {
      const emp = await this.prisma.employee.findFirst({
        where: { id: user.id, orgId: user.orgId, deletedAt: null },
        select: { allBranches: true },
      });
      if (emp?.allBranches) return true;
    }

    // Extract branchId from params or query
    const branchId = request.params?.branchId ?? request.query?.branchId;
    if (!branchId) return true; // no branch filter — pass through

    const access = await this.prisma.employeeBranch.findFirst({
      where: { employeeId: user.id, branchId, orgId: user.orgId },
    });

    if (!access) {
      throw new ForbiddenException('Немає доступу до цієї філії');
    }

    return true;
  }
}
