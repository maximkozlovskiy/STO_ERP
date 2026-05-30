import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UserPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    orgId: string,
    employeeId: string,
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const pref = await this.prisma.userPreference.findFirst({
      where: { orgId, employeeId, key },
      select: { value: true },
    });
    return pref ? (pref.value as Record<string, unknown>) : null;
  }

  async upsert(
    orgId: string,
    employeeId: string,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const jsonValue = value as Prisma.InputJsonValue;
    await this.prisma.userPreference.upsert({
      where: { orgId_employeeId_key: { orgId, employeeId, key } },
      create: { orgId, employeeId, key, value: jsonValue },
      update: { value: jsonValue },
    });
  }
}
