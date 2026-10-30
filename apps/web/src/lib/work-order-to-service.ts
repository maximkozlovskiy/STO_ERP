/**
 * «Зберегти як послугу» (BR-WO-036): рядки наряду → склад послуги каталогу.
 *
 * Послуга зберігає роботу один раз (`@@id([serviceId, workId])`), а `applyService` при застосуванні
 * множить нормо-години роботи з каталогу на `quantity`. Тому кількість роботи — сума годин рядків
 * наряду з цією роботою, поділена на норму каталогу (2 знаки); норма 0 чи сума, що округлилась до
 * 0, → 1. Так само, як міграція шаблонів `20261030190000_work_order_templates_to_services`.
 * Товар — сума кількостей рядків у базовій одиниці (3 знаки, як кількість на складі).
 * Робота чи товар, яких у каталозі вже немає (видалені — `GET /works?ids=` / `GET /goods?ids=` їх
 * не повертають), у послугу не потрапляють: сервер відхилив би всю послугу
 * (`err.service.worksNotFound` / `err.service.goodsNotFound`).
 */

/** Ролі `POST /services` (RBAC-MATRIX «Управління послугами»): решта кнопки не бачить. */
export const SERVICE_WRITE_ROLES: readonly string[] = Object.freeze(['OWNER', 'ADMIN']);

export interface WorkOrderLineForService {
  workId: string;
  normoHours: number;
}

export interface WorkOrderPartForService {
  goodId: string;
  quantity: number;
  /** Скільки базових одиниць в одиниці рядка (`qty_base = qty × coefficient`); немає — 1. */
  coefficient?: number;
}

export interface ServiceDraft {
  works: { workId: string; quantity: number }[];
  goods: { goodId: string; quantity: number }[];
  /** Роботи наряду, яких немає в каталозі (видалені) — у послугу не пішли. */
  skippedWorkIds: string[];
  /** Товари наряду, яких немає в каталозі (видалені) — у послугу не пішли. */
  skippedGoodIds: string[];
}

/** Мінімум кількості послуги на сервері (`@Min(0.01)` у `ServiceWorkItemDto`/`ServiceGoodItemDto`). */
const MIN_SERVICE_QTY = 0.01;

/** Кількість послуги: округлена до `digits` знаків, нуль чи нечисло → 1, не менше мінімуму сервера. */
function positiveQuantity(n: number, digits: number): number {
  const f = 10 ** digits;
  const q = Math.round(n * f) / f;
  if (!Number.isFinite(q) || q <= 0) return 1;
  return Math.max(q, MIN_SERVICE_QTY);
}

/**
 * Рядки наряду → роботи й товари послуги.
 * @param catalogNormoHours норма роботи з каталогу за id; роботи без запису — пропущені.
 * @param catalogGoodIds товари, що є в каталозі; товари поза ним — пропущені. Не передано — не
 *   відсіювати (каталог не питали).
 */
export function buildServiceFromWorkOrder(
  lines: readonly WorkOrderLineForService[],
  parts: readonly WorkOrderPartForService[],
  catalogNormoHours: ReadonlyMap<string, number>,
  catalogGoodIds?: ReadonlySet<string>,
): ServiceDraft {
  const hoursByWork = new Map<string, number>();
  const skipped = new Set<string>();
  for (const l of lines) {
    if (!catalogNormoHours.has(l.workId)) {
      skipped.add(l.workId);
      continue;
    }
    hoursByWork.set(l.workId, (hoursByWork.get(l.workId) ?? 0) + (Number(l.normoHours) || 0));
  }
  const works = [...hoursByWork].map(([workId, hours]) => {
    const norm = catalogNormoHours.get(workId) ?? 0;
    return { workId, quantity: norm > 0 ? positiveQuantity(hours / norm, 2) : 1 };
  });

  const qtyByGood = new Map<string, number>();
  const skippedGoods = new Set<string>();
  for (const p of parts) {
    if (catalogGoodIds && !catalogGoodIds.has(p.goodId)) {
      skippedGoods.add(p.goodId);
      continue;
    }
    // `applyService` додає товар у базовій одиниці — кількість рядка переводимо в неї.
    const coefficient = p.coefficient && p.coefficient > 0 ? p.coefficient : 1;
    const base = (Number(p.quantity) || 0) * coefficient;
    qtyByGood.set(p.goodId, (qtyByGood.get(p.goodId) ?? 0) + base);
  }
  const goods = [...qtyByGood].map(([goodId, qty]) => ({
    goodId,
    quantity: positiveQuantity(qty, 3),
  }));

  return { works, goods, skippedWorkIds: [...skipped], skippedGoodIds: [...skippedGoods] };
}
