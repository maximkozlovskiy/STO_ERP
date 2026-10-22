'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { LiftMechanic } from '@/lib/work-line-executor';
import { employeesKeys } from './useEmployees';

/**
 * Ключ під `employeesKeys.lists()`: правка співробітника (підйомники, категорії, статус) скидає
 * списки співробітників, а з ними й механіків підйомника.
 */
export const liftMechanicsKeys = {
  lift: (liftId: string) => [...employeesKeys.lists(), 'lift-mechanics', liftId] as const,
};

/** Лише поля, потрібні правилу BR-WO-030: відповідь адміну містить телефон, e-mail тощо. */
const toLiftMechanic = (m: LiftMechanic): LiftMechanic => ({
  id: m.id,
  ...(m.status !== undefined && { status: m.status }),
  ...(m.workCategoryIds !== undefined && { workCategoryIds: m.workCategoryIds }),
});

/**
 * Механіки, закріплені за підйомником (BR-WO-030): `GET /employees?liftId=&role=MECHANIC` — сервер
 * віддає лише активних (без відпустки, звільнених, видалених), як для поля «Механік» календаря
 * (BR-CAL-012). Один запит на підйомник на 30 с, спільний для картки наряду і вікна «+ Робота».
 * `null` — підйомника немає, список ще не отримано або запит не вдався: правило тоді не бачить
 * «єдиного механіка», і поле лишається за людиною.
 */
export function useLiftMechanics(liftId: string | null | undefined): LiftMechanic[] | null {
  const key = liftId || '';
  const { data } = useQuery({
    queryKey: liftMechanicsKeys.lift(key),
    queryFn: ({ signal }) =>
      apiFetch<{ items: LiftMechanic[] }>(
        `/employees?liftId=${encodeURIComponent(key)}&role=MECHANIC&limit=200`,
        { signal },
      ).then(r => (r.items ?? []).map(toLiftMechanic)),
    enabled: !!key,
    staleTime: 30_000,
  });
  return key && data ? data : null;
}
