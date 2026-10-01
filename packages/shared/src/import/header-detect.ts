/**
 * Автовизначення колонок файлу-накладної за рядком-заголовком.
 *
 * Споживається І web (майстер імпорту рахує мапінг на клієнті з уже отриманої сирої сітки —
 * без зайвого запиту), І api (для майбутнього серверного автодетекту). Чистий TS без залежностей.
 */

/** Ролі колонок імпорту — дзеркалять ImportMapping (apps/api xlsx.service) і COL_ROLE_LABELS (web). */
export type ImportColRole =
  'codeCol' | 'articleCol' | 'brandCol' | 'nameCol' | 'quantityCol' | 'priceCol';

/**
 * Нормалізація ЗАГОЛОВКА колонки для зіставлення з алиасами.
 *
 * ⚠️ НЕ використовувати `normalizeArticle` (apps/api/src/common/utils/normalize-article.ts) — він
 * НАВМИСНО знищує кирилицю (`[^A-Z0-9]`), тому `normalizeArticle('Артикул') === ''` і ВСІ українські
 * заголовки колапсують у порожній рядок, зіставляючись з усім підряд. Тут навпаки: кирилиця —
 * основний алфавіт заголовків, її зберігаємо.
 *
 * Що робимо: NBSP→пробіл (частий гість Excel-експортів), lowercase, типографські тире→ASCII '-',
 * прибираємо апострофи («кіл-сть»/«кіл'сть»), пунктуацію/дужки/валютні знаки→пробіл, стискаємо
 * пробіли навколо дефіса («к - ть»→«к-ть») і між словами, зрізаємо хвостові одиниці/валюту
 * («Ціна, ₴»→«ціна», «Сума, грн»→«сума»).
 */
export function normalizeHeader(s: string | null | undefined): string {
  let v = (s ?? '')
    .replace(/ /g, ' ') // NBSP
    .toLowerCase()
    .replace(/[‐-―−]/g, '-') // en/em-dash, мінус → '-'
    .replace(/['‘’ʼ]/g, '') // апострофи
    .replace(/[^\p{L}\p{N}\-/ ]+/gu, ' ') // пунктуація/дужки/₴/№ → пробіл
    .replace(/\s*-\s*/g, '-') // «к - ть» → «к-ть»
    .replace(/\s+/g, ' ')
    .trim();
  // Хвостові одиниці/валюта можуть накладатись («Ціна, грн шт») → знімаємо до стабілізації.
  let prev: string;
  do {
    prev = v;
    v = v.replace(/ (?:грн|uah|usd|eur|шт|pcs)$/, '');
  } while (v !== prev);
  return v;
}

/**
 * Алиаси заголовків → роль колонки. Константа, НЕ таблиця в БД: мова накладних спільна для всіх
 * org, а per-counterparty кастомізація вже покрита збереженим мапінгом (CounterpartyImportMapping).
 * Значення — вже нормалізовані (результат normalizeHeader), порівняння йде з нормалізованою коміркою.
 *
 * Сід зібрано з реальних джерел проєкту: CSV-гілка applyPricingFromList, XLSX-шаблони що генерує
 * сам проєкт, експорт нарядів, лейбли майстра імпорту (обидва варіанти «Назва»/«Найменування»).
 */
export const IMPORT_HEADER_ALIASES: Record<ImportColRole, readonly string[]> = {
  codeCol: [
    'код',
    'код товару',
    'внутрішній код',
    'внутр код',
    'код тмц',
    'номенклатурний код',
    'код номенклатури',
    'id',
  ],
  articleCol: [
    'артикул',
    'артикул sku',
    'sku',
    'арт',
    'код артикулу',
    'артикул товару',
    'каталожний номер',
    'кат номер',
    'part number',
    'partnumber',
    'oem',
    'номер деталі',
    'артикул производителя',
  ],
  brandCol: [
    'бренд',
    'виробник',
    'торгова марка',
    'торг марка',
    'марка',
    'тм',
    'производитель',
    'manufacturer',
    'brand',
  ],
  nameCol: [
    'назва',
    'найменування',
    'назва товару',
    'найменування товару',
    'номенклатура',
    'товар',
    'опис',
    'наименование',
    'назва позиції',
    'description',
    'name',
  ],
  quantityCol: ['к-сть', 'к-ть', 'кількість', 'кіл-сть', 'кол-во', 'количество', 'qty', 'quantity'],
  priceCol: [
    'ціна',
    'цена',
    'ціна закупки',
    'ціна за од',
    'ціна за одиницю',
    'ціна без пдв',
    'ціна з пдв',
    'ціна постачальника',
    'закупівельна ціна',
    'price',
  ],
};

/**
 * Заголовки, які НЕ мають мапитись у жодну роль. Без цього «Сума, грн» підхопилась би у priceCol
 * (містить «ціна»-подібні ознаки за substring), а «Ціна продажу» перебила б закупівельну ціну.
 */
export const IMPORT_HEADER_NEGATIVE: readonly string[] = [
  'сума',
  'всього',
  'разом',
  'total',
  'знижка',
  'пдв',
  'од виміру',
  'од',
  'одиниця',
  'категорія',
  'ціна продажу',
  'склад',
  'примітка',
  'дата',
];

/** Результат автовизначення. cols — 1-based номери колонок (як у ImportMapping). */
export interface DetectedMapping {
  /** 1-based рядок першого товару = headerRowIndex + 2. Фолбек 2, якщо шапку не знайдено. */
  startRow: number;
  cols: Partial<Record<ImportColRole, number>>;
  /** 0-based індекс рядка-шапки у сітці; null → шапку не розпізнано. */
  headerRowIndex: number | null;
  /** Скільки ролей розпізнано — викликач вирішує, чи довіряти (поріг 2). */
  matchedCount: number;
}

const ROLES: readonly ImportColRole[] = [
  'codeCol',
  'articleCol',
  'brandCol',
  'nameCol',
  'quantityCol',
  'priceCol',
];

/**
 * Скоринг «нормалізована комірка ↔ алиас». Градації замість булевого match, щоб точний збіг
 * вигравав у часткового: «Ціна закупки» має віддати priceCol за prefix, але якщо поруч є точна
 * «Ціна» — виграє вона.
 */
function scoreCell(cell: string, alias: string): number {
  if (!cell) return 0;
  // Точний збіг. Коротша комірка — специфічніша для ролі: при виборі між «Ціна» і «Ціна закупки»
  // (обидві точно збігаються зі СВОЇМ алиасом) для накладної правильніша чиста «Ціна». Віднімаємо
  // довжину комірки, щоб коротша вигравала, лишаючись вище за всі часткові збіги (max 80).
  if (cell === alias) return 100 - Math.min(cell.length, 19);
  if (cell.startsWith(`${alias} `)) return 80; // «ціна закупки» ← «ціна»
  if (cell.split(' ').includes(alias)) return 70; // «артикул sku» ← «sku»
  // Guard на довжину: без нього короткі алиаси («од», «тм», «id») матчили б підрядок будь-де.
  if (alias.length >= 4 && cell.includes(alias)) return 55;
  return 0;
}

/** Найкращий бал ролі для комірки (0 = не підходить, негативний список блокує). */
function scoreRole(cell: string, role: ImportColRole): number {
  if (!cell) return 0;
  if (IMPORT_HEADER_NEGATIVE.includes(cell)) return 0;
  let best = 0;
  for (const alias of IMPORT_HEADER_ALIASES[role]) {
    const s = scoreCell(cell, alias);
    if (s > best) best = s;
  }
  return best;
}

/** Скільки різних ролей розпізнається у рядку — критерій «це шапка». */
function countMatchedRoles(cells: readonly string[]): number {
  let n = 0;
  for (const role of ROLES) {
    if (cells.some(c => scoreRole(normalizeHeader(c), role) > 0)) n++;
  }
  return n;
}

/**
 * Автовизначення мапінгу за сирою сіткою передперегляду. Чиста функція, без I/O.
 *
 * Крок 1: шукає рядок-шапку серед перших maxHeaderScanRows рядків (виграє з найбільшою кількістю
 * розпізнаних ролей; при рівності — ПЕРШИЙ, бо шапка стоїть вище даних).
 * Крок 2: жадібне призначення 1:1 за спаданням балу — колонка не може стати і артикулом, і кодом.
 *
 * matchedCount < 2 → вважаємо, що шапки немає (один випадковий збіг нічого не означає):
 * cols порожній, headerRowIndex null, викликач лишає мапінг як є.
 */
export function detectMappingFromGrid(
  rows: readonly (readonly string[])[],
  opts?: { maxHeaderScanRows?: number },
): DetectedMapping {
  const scanLimit = Math.max(1, opts?.maxHeaderScanRows ?? 10);
  const empty: DetectedMapping = { startRow: 2, cols: {}, headerRowIndex: null, matchedCount: 0 };
  if (!rows.length) return empty;

  // ── Крок 1: рядок-шапка ──
  let headerRowIndex = -1;
  let bestMatched = 0;
  for (let i = 0; i < Math.min(scanLimit, rows.length); i++) {
    const n = countMatchedRoles(rows[i] ?? []);
    if (n > bestMatched) {
      bestMatched = n;
      headerRowIndex = i;
    }
  }
  if (headerRowIndex < 0 || bestMatched < 2) return empty;

  // ── Крок 2: жадібне 1:1 призначення ──
  const cells = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const pairs: { role: ImportColRole; col: number; score: number }[] = [];
  for (const role of ROLES) {
    for (let c = 0; c < cells.length; c++) {
      const score = scoreRole(cells[c] ?? '', role);
      if (score > 0) pairs.push({ role, col: c + 1, score }); // 1-based
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.col - b.col);

  const cols: Partial<Record<ImportColRole, number>> = {};
  const usedCols = new Set<number>();
  for (const p of pairs) {
    if (cols[p.role] !== undefined || usedCols.has(p.col)) continue;
    cols[p.role] = p.col;
    usedCols.add(p.col);
  }

  return {
    startRow: headerRowIndex + 2, // 1-based рядок, наступний за шапкою
    cols,
    headerRowIndex,
    matchedCount: Object.keys(cols).length,
  };
}
