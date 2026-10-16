import { EmployeeStatus, UserRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Ролі, що створюють, змінюють і видаляють записи календаря (BR-CAL-010). Одне джерело для
 * `@Roles` контролера календаря і для синхронізації з планшета (`sync push calendar_slots`).
 */
export const CALENDAR_WRITE_ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST'] as const;

export function canWriteCalendar(role: string | undefined): boolean {
  return (CALENDAR_WRITE_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * BR-CAL-012: механік запису — активний (не звільнений, не видалений і не у відпустці) MECHANIC
 * своєї організації, закріплений за підйомником запису (`EmployeeLift`). Без підйомника
 * закріпитись нема за чим — `null` без запиту. Один запит: умови — у `where`, а не перевірка
 * прочитаного. Те саме читає `GET /employees?liftId=` (список поля «Механік»), запис календаря і
 * синхронізація з планшета.
 */
export function findMechanicOnLift(
  prisma: Pick<PrismaService, 'employee'>,
  orgId: string,
  employeeId: string,
  liftId: string | null,
): Promise<{ id: string } | null> {
  if (!liftId) return Promise.resolve(null);
  return prisma.employee.findFirst({
    where: {
      id: employeeId,
      orgId,
      deletedAt: null,
      role: UserRole.MECHANIC,
      status: EmployeeStatus.ACTIVE,
      employeeLifts: { some: { liftId } },
    },
    select: { id: true },
  });
}
