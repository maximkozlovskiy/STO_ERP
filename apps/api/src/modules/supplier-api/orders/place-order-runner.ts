import type { PlaceOrderRunner, SupplierOrderState } from '../adapters/supplier-adapter.interface';
import { isSupplierError } from '../http/supplier-errors';

/** Крок звірки: неповторюваний виклик закінчився невідомо чим (BR-SCON-011). */
export const RECONCILE_STEP = 'RECONCILE';
/** Зовнішнє замовлення оформлено — кроків більше немає. */
export const DONE_STEP = 'DONE';
export const PENDING_SUFFIX = ':PENDING';

/** Попередня спроба оборвалась посеред неповторюваного кроку чи впала неоднозначно. */
export function needsReconcile(step: string | null | undefined): boolean {
  return step === RECONCILE_STEP || (!!step && step.endsWith(PENDING_SUFFIX));
}

/**
 * Сигнал обробнику: неповторюваний крок упав неоднозначно, наступна спроба має почати зі звірки
 * за `reference`, а не з повтору виклику.
 */
export class SupplierReconcileRequired extends Error {
  constructor(
    readonly step: string,
    readonly causeError: unknown,
  ) {
    super(
      `Крок «${step}» завершився невідомо чим: ${causeError instanceof Error ? causeError.message : String(causeError)}`,
    );
    this.name = 'SupplierReconcileRequired';
  }
}

/**
 * Виконавець кроків відправки (BR-SCON-011). Кроки — у порядку `steps` адаптера; завершений
 * крок (за `state.step`) при повторі задачі пропускається. Неповторюваний крок перед викликом
 * записується як `<крок>:PENDING` (рестарт посеред виклику → звірка), після успіху — як
 * завершений разом із зовнішніми id. Неоднозначна відмова неповторюваного кроку → крок
 * RECONCILE і SupplierReconcileRequired; однозначна (ліміт, 4xx) — повернення до попереднього
 * кроку: виклик точно не виконано, повтор безпечний.
 *
 * `persist` записує зміну в SupplierOrder ДО наступного кроку — у пам'яті стан лише дзеркало.
 */
export function createPlaceOrderRunner(
  steps: readonly string[],
  initial: SupplierOrderState,
  persist: (patch: Partial<SupplierOrderState>) => Promise<void>,
): PlaceOrderRunner {
  const state: SupplierOrderState = { ...initial };
  return {
    get state() {
      return state;
    },
    async step(name, opts, fn) {
      const idx = steps.indexOf(name);
      if (idx < 0) throw new Error(`Невідомий крок відправки «${name}»`);
      const doneIdx = state.step ? steps.indexOf(state.step) : -1;
      if (doneIdx >= idx) return;
      const previous = state.step;
      if (!opts.repeatable) await persist({ step: `${name}${PENDING_SUFFIX}` });
      let patch: Partial<SupplierOrderState> | void;
      try {
        patch = await fn();
      } catch (e) {
        if (!opts.repeatable) {
          const ambiguous = isSupplierError(e) ? e.ambiguous : true;
          if (ambiguous) {
            await persist({ step: RECONCILE_STEP });
            throw new SupplierReconcileRequired(name, e);
          }
          await persist({ step: previous });
        }
        throw e;
      }
      Object.assign(state, patch ?? {}, { step: name });
      await persist({ ...(patch ?? {}), step: name });
    },
  };
}
