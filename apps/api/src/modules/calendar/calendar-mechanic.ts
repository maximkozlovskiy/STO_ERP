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
 * Чому механіка не можна поставити на запис (BR-CAL-012): `ON_LEAVE` — у відпустці;
 * `NOT_ON_LIFT` — активний механік, не закріплений за підйомником запису (або підйомника немає);
 * `UNAVAILABLE` — інше: звільнений, видалений, не MECHANIC, чужої організації чи неіснуючий.
 */
export type MechanicRejectReason = 'ON_LEAVE' | 'NOT_ON_LIFT' | 'UNAVAILABLE';

export type MechanicOnLiftResult =
  { ok: true; id: string } | { ok: false; reason: MechanicRejectReason };

/** Ключ тексту 400 для причини: «у відпустці» окремо (рішення власника 2026-10-16, друге). */
export const MECHANIC_REJECT_KEY: Record<MechanicRejectReason, string> = {
  ON_LEAVE: 'err.calendar.employeeOnLeave',
  NOT_ON_LIFT: 'err.calendar.employeeNotOnLift',
  UNAVAILABLE: 'err.calendar.employeeNotFound',
};

/**
 * BR-CAL-012: механік запису — активний (не звільнений, не видалений і не у відпустці) MECHANIC
 * своєї організації, закріплений за підйомником запису (`EmployeeLift`). Без підйомника
 * закріпитись нема за чим — `NOT_ON_LIFT` без запиту. Прийнятий механік — один запит, умови в
 * `where`, а не перевірка прочитаного. Лише відмова читає другий раз — причину: механік цієї
 * організації у відпустці → `ON_LEAVE` (навіть якщо ще й не закріплений: повернути його на
 * підйомник не допоможе), активний → `NOT_ON_LIFT`, інакше `UNAVAILABLE`. Те саме читає
 * `GET /employees?liftId=` (список поля «Механік»), запис календаря і синхронізація з планшета.
 */
export async function findMechanicOnLift(
  prisma: Pick<PrismaService, 'employee'>,
  orgId: string,
  employeeId: string,
  liftId: string | null,
): Promise<MechanicOnLiftResult> {
  if (!liftId) return { ok: false, reason: 'NOT_ON_LIFT' };
  const mechanic = { id: employeeId, orgId, deletedAt: null, role: UserRole.MECHANIC };
  const found = await prisma.employee.findFirst({
    where: { ...mechanic, status: EmployeeStatus.ACTIVE, employeeLifts: { some: { liftId } } },
    select: { id: true },
  });
  if (found) return { ok: true, id: found.id };
  const other = await prisma.employee.findFirst({
    where: { ...mechanic, status: { in: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] } },
    select: { status: true },
  });
  if (other?.status === EmployeeStatus.ON_LEAVE) return { ok: false, reason: 'ON_LEAVE' };
  if (other?.status === EmployeeStatus.ACTIVE) return { ok: false, reason: 'NOT_ON_LIFT' };
  return { ok: false, reason: 'UNAVAILABLE' };
}
