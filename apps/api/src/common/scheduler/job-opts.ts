import type { DefaultJobOptions } from 'bullmq';

/**
 * Спільна політика утримання job-ів у Redis для ВСІХ черг (offline-first: БД+Redis живуть на ПК
 * СТО, не можна рости безмежно). Передається у `BullModule.registerQueue({ defaultJobOptions })` —
 * кожен `.add()` успадковує це, а per-job опції (`attempts`/`backoff`/`jobId`/явний `removeOnFail`)
 * перекривають дефолт де потрібно.
 *
 * Раніше `removeOnComplete:true` + `removeOnFail:200` копіювались у ~11 `.add()`-сайтів; F1-фікс
 * мусив вставити `removeOnFail` у 4 scheduler-и вручну — саме симптом відсутнього спільного дефолту.
 * Тепер новий `.add()`/нова черга успадковують cap автоматично (клас «failed-set росте» закрито раз).
 *
 * `removeOnFail: 200` — тримаємо останні 200 невдалих job-ів для діагностики, старіші видаляємо.
 */
export const DEFAULT_JOB_OPTS: DefaultJobOptions = {
  removeOnComplete: true,
  removeOnFail: 200,
};
