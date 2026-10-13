import { useQuery } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';

/**
 * Зведення по табличних частинах документа (BR-WO-009) і виконавці наряду (BR-WO-010).
 * Backend: GET /<entity>/:id/lines-summary → LinesSummaryDto. Типи — згенеровані з OpenAPI
 * (docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє»).
 *
 * Зведення НЕ рахується з довантаженого документа: ролі в ендпоінта — як у списку, а
 * `GET /purchase-orders/:id` бухгалтерові закритий, хоча список він бачить.
 */
export type LinesSummary = ApiSchema<'LinesSummaryDto'>;
export type LinesSummaryTable = ApiSchema<'LinesSummaryTableDto'>;
export type LinesSummaryExecutor = ApiSchema<'LinesSummaryExecutorDto'>;

/** Сутності, що мають ендпоінт зведення. Значення = сегмент URL = корінь ключів сутності. */
export type LinesSummaryEntity =
  'work-orders' | 'invoices' | 'purchase-orders' | 'stock-documents' | 'supplier-returns';

/**
 * Ключ лежить УСЕРЕДИНІ простору ключів сутності: `['work-orders', 'lines-summary', id]` має
 * префікс `workOrdersKeys.all` (так само для решти чотирьох). Тому кожна наявна інвалідація
 * `<сутність>Keys.all` — після збереження картки, переходу статусу, видалення — зачіпає і
 * зведення, без окремого виклику в кожному обробнику.
 */
export const linesSummaryKeys = {
  all: (entity: LinesSummaryEntity) => [entity, 'lines-summary'] as const,
  detail: (entity: LinesSummaryEntity, id: string) =>
    [...linesSummaryKeys.all(entity), id] as const,
};

/**
 * staleTime: 0 — зведення перечитується щоразу, коли рядок вибирають у панель: рядки документа
 * міняють і там, де ключ сутності не інвалідується (окрема сторінка наряду, планшет механіка,
 * інший користувач). gcTime лишає кеш, тож повторний вибір не блимає скелетоном — видно
 * попередні числа, доки йде фоновий запит (той самий розрахунок, що в useVehicleMileage).
 */
const OPTS = { staleTime: 0, gcTime: 5 * 60_000 } as const;

/**
 * @param enabled — панель відкрита (вкладка з блоком видима). Без id або з `enabled: false`
 *   запит не йде взагалі.
 */
export function useLinesSummary(entity: LinesSummaryEntity, id: string | null, enabled = true) {
  return useQuery({
    queryKey: linesSummaryKeys.detail(entity, id ?? ''),
    queryFn: ({ signal }) => apiFetch<LinesSummary>(`/${entity}/${id}/lines-summary`, { signal }),
    enabled: enabled && !!id,
    ...OPTS,
  });
}
