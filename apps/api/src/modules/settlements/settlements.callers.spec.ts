/**
 * СТАТИЧНИЙ сторож місць виклику `SettlementsService.createTransaction()` (BR-SETL-010).
 *
 * `createTransaction` НЕ ідемпотентна: другий виклик із тими самими `documentType` / `documentId` /
 * `type` пише другий рядок журналу і вдруге змінює баланс (контракт закріплено в
 * `settlements.service.spec.ts`). «Не нарахувати двічі» — обов'язок викликача. Отже правило живе
 * не в модулі `settlements`, а в КОЖНОМУ місці виклику — і нове місце виклику без власного захисту
 * unit-тести модуля `settlements` не помітять ніяк.
 *
 * Тому сторож читає вихідний код: TypeScript-парсером обходить `apps/api/src` (без спеків),
 * знаходить усі виклики `<щось>.createTransaction(…)` і звіряє їх із переліком CALL_SITES нижче:
 * «файл # метод : тип проводки → чим захищено від повтору».
 *
 *   • нове місце виклику без запису в переліку → тест падає з підказкою;
 *   • зникле місце виклику (запис лишився) → теж падає;
 *   • якір захисту (CAS статусу, перевірка наявної проводки тощо) зник із коду або опинився ПІСЛЯ
 *     виклику → падає: запис у переліку описує код, а не обіцянку.
 *
 * Чого сторож НЕ робить: не доводить, що захист достатній (це справа тестів гонки в модулі
 * викликача — вони названі в полі `raceTest`), і не бачить виклик через змінну-посилання
 * (`const f = this.settlements.createTransaction; f(…)`).
 *
 * Сторож НЕ лагодить код. Місце, де захисту не знайдено, записується з `unprotected: true` —
 * тест проходить, але таке місце видно в окремому кейсі.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC_DIR = join(__dirname, '..', '..');
const MODULES_DIR = join(SRC_DIR, 'modules');

/** Наявний тест подвійного виклику / гонки: файл спеку (від `modules/`) і точна назва кейсу. */
interface RaceTest {
  spec: string;
  title: string;
}

interface CallSite {
  /** Чим це місце захищене від повторного нарахування (людською мовою). */
  guard: string;
  /**
   * Якорі захисту: кожен вираз мусить знайтися в тілі методу ДО виклику `createTransaction`
   * (для `guardedBy` — у тілі методу-викликача до виклику методу з проводкою).
   */
  anchors: RegExp[];
  /** Якорі в самих аргументах виклику `createTransaction` (напр. `documentId: created.id`). */
  argAnchors?: RegExp[];
  /**
   * Захист стоїть не в методі з проводкою, а в його ЄДИНОМУ викликачі. Сторож перевіряє, що
   * викликач справді один і що якорі стоять у ньому перед викликом.
   */
  guardedBy?: { file: string; method: string; calls: string };
  /** true — захисту від повтору в коді не знайдено (знахідка; тест проходить, але місце видно). */
  unprotected?: true;
  /** Тести гонки / повтору цього місця в модулі викликача; порожньо — окремого тесту немає. */
  raceTests: RaceTest[];
  /** Що лишається непокритим (чесна примітка, не захист). */
  note?: string;
}

const INVOICE_STATUS_CAS = [
  /tx\.invoice\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*inv\.status\b/,
  /if\s*\(moved\.count === 0\)\s*\{\s*throw\b/,
];
const WORK_ORDER_STATUS_CAS = [
  /tx\.workOrder\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*wo\.status\b/,
  /if\s*\(cas\.count === 0\)\s*\{\s*throw\b/,
];
const FX_ALREADY_BOOKED = [
  /tx\.settlementTransaction\.count\(\{\s*where:\s*\{[^}]*type:\s*\{\s*in:\s*\['FX_GAIN',\s*'FX_LOSS'\]/,
  /if\s*\(fxExisting === 0\)/,
];

/**
 * ПЕРЕЛІК МІСЦЬ ВИКЛИКУ. Ключ: `<файл від apps/api/src>#<метод>:<тип проводки>`.
 * Тип — рядкові літерали з поля `type` аргументу (кілька — через `|`, за абеткою).
 *
 * Додаєш виклик `createTransaction` — додай сюди запис і напиши, ЧИМ він захищений від повтору
 * (і якір, за яким сторож цей захист знайде в коді). Захисту немає — `unprotected: true`.
 */
const CALL_SITES: Record<string, CallSite> = {
  // ── Рахунки ────────────────────────────────────────────────────────────────────────────
  'modules/invoices/invoices.service.ts#transition:CHARGE': {
    guard:
      'CAS статусу в тій самій tx: invoice.updateMany where status = прочитаний (DRAFT); count=0 → 400 до проводки. ' +
      'Нараховується лише на DRAFT→SENT standalone-рахунку; назад у DRAFT переходу немає.',
    anchors: [...INVOICE_STATUS_CAS, /inv\.status === InvoiceStatus\.DRAFT/],
    raceTests: [
      {
        spec: 'invoices/invoices.transition-settlements.spec.ts',
        title:
          'CAS: updateMany count=0 (статус змінився паралельно) → throw, CHARGE не створюється',
      },
    ],
  },
  'modules/invoices/invoices.service.ts#transition:PAYMENT': {
    guard:
      'Той самий CAS статусу (updateMany where status = прочитаний) у тій самій tx; PAID — термінальний статус, ' +
      'повторно увійти в нього не можна. Сума — лише непокритий залишок (amount − paidAmount).',
    anchors: [...INVOICE_STATUS_CAS, /newStatus === InvoiceStatus\.PAID/],
    raceTests: [],
    note:
      'Окремого кейсу «CAS програв на →PAID → PAYMENT не пишеться» немає: спільний CAS перевірено лише ' +
      'кейсом DRAFT→SENT (CHARGE).',
  },
  'modules/invoices/invoices.service.ts#transition:FX_GAIN|FX_LOSS': {
    guard:
      'CAS статусу (→PAID, термінальний) + перевірка наявної проводки: settlementTransaction.count ' +
      'FX_GAIN/FX_LOSS цього рахунку === 0 у тій самій tx.',
    anchors: [...INVOICE_STATUS_CAS, ...FX_ALREADY_BOOKED],
    raceTests: [
      {
        spec: 'invoices/invoices.transition-settlements.spec.ts',
        title:
          'іновалютний ручний →PAID, FX вже проведено (count>0) → повторно НЕ бронюється (Bug #745 idempotency)',
      },
    ],
  },

  // ── Оплати клієнтів ────────────────────────────────────────────────────────────────────
  'modules/payments/payments.service.ts#create:PAYMENT': {
    guard:
      'Проводка 1:1 із щойно створеним документом Payment у тій самій tx (documentId = created.id) — ' +
      'повторної проводки для того самого Payment не буває. Від повторного створення самого Payment: ' +
      'CAS paidAmount рахунку (updateMany where paidAmount = прочитаний) + перевірка залишку; ' +
      '@unique onlinePaymentIntentId (P2002) для онлайн-оплат; IdempotencyInterceptor на POST /payments.',
    anchors: [
      /const created = await tx\.payment\.create\(/,
      /tx\.invoice\.updateMany\(\{\s*where:\s*\{[^}]*paidAmount:\s*inv\.paidAmount\b/,
      /onlinePaymentIntentId:\s*dto\.onlinePaymentIntentId/,
    ],
    argAnchors: [/documentType:\s*'Payment'/, /documentId:\s*created\.id\b/],
    raceTests: [
      {
        spec: 'payments/payments.idempotency.spec.ts',
        title:
          'CAS count=0 (paidAmount змінено паралельно) → throw, БЕЗ payment.create та settlement',
      },
      {
        spec: 'payments/payment-polling.processor.spec.ts',
        title:
          'конкурентний 2-й poll: paid але CAS count=0 → payments.create НЕ викликається (no double)',
      },
    ],
    note:
      'Оплата без invoiceId і без onlinePaymentIntentId (аванс, пряма оплата наряду) у сервісі нічим не ' +
      'дедуплікується: два однакові виклики create() — це два платежі. Тримає лише Idempotency-Key клієнта.',
  },
  'modules/payments/payments.service.ts#create:FX_GAIN|FX_LOSS': {
    guard:
      'Гілка досяжна лише коли цей платіж перевів рахунок у PAID під CAS paidAmount; далі перевірка наявної ' +
      'проводки: settlementTransaction.count FX_GAIN/FX_LOSS цього рахунку === 0 у тій самій tx.',
    anchors: [
      /tx\.invoice\.updateMany\(\{\s*where:\s*\{[^}]*paidAmount:\s*inv\.paidAmount\b/,
      /newStatus === 'PAID'/,
      ...FX_ALREADY_BOOKED,
    ],
    raceTests: [
      {
        spec: 'payments/payments.multicurrency.spec.ts',
        title: 'idempotency: FX для рахунку вже проведено (count>0) → повторно НЕ бронюється',
      },
    ],
  },

  // ── Закупівлі ──────────────────────────────────────────────────────────────────────────
  'modules/purchase-orders/purchase-orders.service.ts#receive:SUPPLIER_CHARGE': {
    guard:
      'CAS кожного рядка в тій самій tx ДО руху й боргу: purchaseOrderLine.updateMany where receivedQty = ' +
      'прочитане; count=0 → 400. Перед tx — відмова, якщо прийом перевищує залишок рядка.',
    anchors: [
      /line\.receivedQty \+ recv\.receivedQty > line\.quantity/,
      /tx\.purchaseOrderLine\.updateMany\(\{\s*where:\s*\{[^}]*receivedQty:\s*line\.receivedQty\b/,
      /if\s*\(casResult\.count === 0\)\s*\{\s*throw\b/,
    ],
    raceTests: [
      {
        spec: 'purchase-orders/purchase-orders.receive-uom.spec.ts',
        title:
          'CAS-guard: рядок уже змінено (updateMany count=0) → throw, БЕЗ RECEIPT-руху і БЕЗ SUPPLIER_CHARGE',
      },
      {
        spec: 'purchase-orders/purchase-orders.receive-ledger.spec.ts',
        title:
          'CAS ДРУГОГО рядка не зійшовся → throw; жодного RECEIPT-руху (і для першого рядка теж) і без SUPPLIER_CHARGE',
      },
    ],
    note:
      'Захищає від ОДНОЧАСНОГО дубля. Послідовний повтор часткового прийому (10 із 100, потім ще раз ті самі ' +
      '10) від справжнього другого прийому не відрізняється — пройде як другий SUPPLIER_CHARGE, доки не ' +
      'вичерпано залишок рядка.',
  },

  // ── Оплати постачальникам ──────────────────────────────────────────────────────────────
  'modules/supplier-payments/supplier-payments.service.ts#confirm:SUPPLIER_PAYMENT': {
    guard:
      'CAS статусу першим записом у tx: supplierPayment.updateMany where status = DRAFT → CONFIRMED; ' +
      'count=0 → 400. CONFIRMED — термінальний.',
    anchors: [
      /tx\.supplierPayment\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*SupplierPaymentStatus\.DRAFT\b/,
      /if\s*\(cas\.count === 0\)\s*\{\s*throw\b/,
    ],
    raceTests: [
      {
        spec: 'supplier-payments/supplier-payments.confirm.spec.ts',
        title:
          'confirm(): CAS програв (updateMany count=0, concurrent) → BadRequest, settlement НЕ пишеться',
      },
    ],
  },
  'modules/supplier-payments/supplier-payments.service.ts#confirm:FX_GAIN|FX_LOSS': {
    guard:
      'CAS статусу оплати + CAS paidAmount замовлення (purchaseOrder.updateMany where paidAmount = прочитаний) + ' +
      'лише при ПЕРШІЙ повній оплаті (paidAt == null) + перевірка наявної проводки: count FX цього PO === 0.',
    anchors: [
      /tx\.supplierPayment\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*SupplierPaymentStatus\.DRAFT\b/,
      /po\.paidAt == null/,
      /tx\.purchaseOrder\.updateMany\(\{\s*where:\s*\{[^}]*paidAmount:\s*po\.paidAmount\b/,
      /if\s*\(paidCas\.count === 0\)\s*\{\s*throw\b/,
      ...FX_ALREADY_BOOKED,
    ],
    raceTests: [
      {
        spec: 'supplier-payments/supplier-payments.payables-fx.spec.ts',
        title: 'idempotency: FX для PO вже проведено (count>0) → повторно НЕ бронюється',
      },
      {
        spec: 'supplier-payments/supplier-payments.payables-fx.spec.ts',
        title: 'повторна оплата після повної (paidAt≠null) → paidAmount інкремент, БЕЗ другого FX',
      },
      {
        spec: 'supplier-payments/supplier-payments.payables-fx.spec.ts',
        title: 'concurrency: paidAmount CAS count=0 (паралельна оплата) → 400',
      },
    ],
  },

  // ── Повернення постачальнику ───────────────────────────────────────────────────────────
  'modules/supplier-returns/supplier-returns.service.ts#confirm:SUPPLIER_REFUND': {
    guard:
      'CAS статусу першим записом у tx: supplierReturn.updateMany where status = DRAFT → CONFIRMED; ' +
      'count=0 → 400. CONFIRMED — термінальний.',
    anchors: [
      /tx\.supplierReturn\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*SupplierReturnStatus\.DRAFT\b/,
      /if\s*\(cas\.count === 0\)\s*\{\s*throw\b/,
    ],
    raceTests: [
      {
        spec: 'supplier-returns/supplier-returns.confirm-fsm.spec.ts',
        title: 'confirm() concurrent: CAS updateMany count=0 → BadRequest, БЕЗ WRITEOFF/REFUND',
      },
    ],
  },

  // ── Банківські платежі (вихідні) ───────────────────────────────────────────────────────
  'modules/bank-statements/bank-reconciliation.service.ts#reconcile:REFUND_OUT': {
    guard:
      'CAS статусу рядка першим записом у tx: bankTransaction.updateMany where status = UNMATCHED → MATCHED; ' +
      'count=0 → 409/404 до проводки (BR-BANK-026, 030). Проводка — у тій самій tx, documentId = id рядка.',
    anchors: [
      /tx\.bankTransaction\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*'UNMATCHED'/,
      /if\s*\(captured\.count === 0\)\s*\{\s*throw\b/,
    ],
    argAnchors: [/documentType:\s*'BankTransaction'/, /documentId:\s*txId/],
    raceTests: [
      {
        spec: 'bank-statements/bank-reconciliation.outgoing.spec.ts',
        title: 'CAS програв гонку, вид %s → 409, ефект не викликано',
      },
    ],
  },
  'modules/bank-statements/bank-reconciliation.service.ts#unreconcile:REFUND_OUT_CANCEL': {
    guard:
      'CAS статусу рядка першим записом у tx: bankTransaction.updateMany where status = MATCHED, paymentId = null, ' +
      'matchedType = прочитаний → UNMATCHED; count=0 → 409 до сторно (BR-BANK-039, 040). Повторне скасування ' +
      'не знаходить рядок у MATCHED, тож другого сторно немає.',
    anchors: [
      /tx\.bankTransaction\.updateMany\(\{\s*where:\s*\{[^}]*\bstatus:\s*'MATCHED'/,
      /if\s*\(released\.count === 0\)\s*\{\s*throw\b/,
    ],
    argAnchors: [/documentType:\s*'BankTransaction'/, /documentId:\s*txId/],
    raceTests: [
      {
        spec: 'bank-statements/bank-reconciliation.unreconcile.spec.ts',
        title: 'CAS програв гонку, вид %s → 409, зворотного запису немає',
      },
    ],
  },

  // ── Наряди ─────────────────────────────────────────────────────────────────────────────
  'modules/work-orders/work-order-stock-effects.service.ts#writeOffPartsAndCharge:CHARGE': {
    guard:
      'У самому методі захисту НЕМАЄ — він у єдиному викликачі WorkOrdersService.transition: CAS статусу ' +
      'наряду (workOrder.updateMany where status = прочитаний) у тій самій tx перед side-effects; у COMPLETED ' +
      'з FSM можна зайти лише з IN_PROGRESS, а назад із COMPLETED у IN_PROGRESS переходу немає.',
    anchors: [...WORK_ORDER_STATUS_CAS, /if\s*\(newStatus === 'COMPLETED'\)/],
    guardedBy: {
      file: 'modules/work-orders/work-orders.service.ts',
      method: 'transition',
      calls: 'writeOffPartsAndCharge',
    },
    raceTests: [
      {
        spec: 'work-orders/work-orders.service.spec.ts',
        title: 'CAS програв (updateMany count=0) → throw, side-effects НЕ виконуються повторно',
      },
    ],
  },
  'modules/work-orders/work-order-stock-effects.service.ts#returnPartsAndCredit:CREDIT_NOTE': {
    guard:
      'У самому методі захисту НЕМАЄ — він у єдиному викликачі WorkOrdersService.transition: той самий CAS ' +
      'статусу наряду; гілка лише для COMPLETED→CANCELLED, CANCELLED — термінальний.',
    anchors: [...WORK_ORDER_STATUS_CAS, /newStatus === 'CANCELLED' && wo\.status === 'COMPLETED'/],
    guardedBy: {
      file: 'modules/work-orders/work-orders.service.ts',
      method: 'transition',
      calls: 'returnPartsAndCredit',
    },
    raceTests: [],
    note:
      'Окремого кейсу «CAS програв на COMPLETED→CANCELLED → CREDIT_NOTE не пишеться» немає: спільний CAS ' +
      'перевірено лише кейсом →COMPLETED.',
  },
};

// ── Обхід коду ───────────────────────────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec-fixture.ts') &&
      !entry.endsWith('.d.ts')
    )
      out.push(full);
  }
  return out;
}

const relPath = (file: string) => relative(SRC_DIR, file).split('\\').join('/');

interface MethodCall {
  /** файл від `apps/api/src` */
  file: string;
  /** метод класу (або функція), у тілі якого стоїть виклик; `<top-level>` — поза методом */
  method: string;
  /** текст тіла методу від його початку до початку виклику */
  before: string;
  /** текст самого виклику з аргументами */
  callText: string;
  node: ts.CallExpression;
  source: ts.SourceFile;
}

function enclosingMethod(node: ts.Node): ts.MethodDeclaration | ts.FunctionDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** Усі виклики `<вираз>.<name>(…)` у продукт-коді `apps/api/src`. */
function findMethodCalls(name: string): MethodCall[] {
  const hits: MethodCall[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(name)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === name
      ) {
        const owner = enclosingMethod(node);
        hits.push({
          file: relPath(file),
          method: owner?.name?.getText(source) ?? '<top-level>',
          before: owner ? text.slice(owner.getStart(source), node.getStart(source)) : '',
          callText: node.getText(source),
          node,
          source,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

/** Тип проводки з аргументу-об'єкта: літерали поля `type`, за абеткою через `|`. */
function settlementTypeOf(call: MethodCall): string {
  const dto = call.node.arguments[1];
  if (!dto || !ts.isObjectLiteralExpression(dto)) return '<не літерал>';
  const prop = dto.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText(call.source) === 'type',
  );
  if (!prop) return '<без type>';
  const literals: string[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(n.text);
    ts.forEachChild(n, collect);
  };
  collect(prop.initializer);
  return literals.length ? [...new Set(literals)].sort().join('|') : '<не літерал>';
}

const siteKey = (call: MethodCall) => `${call.file}#${call.method}:${settlementTypeOf(call)}`;

function findCreateTransactionCalls(): MethodCall[] {
  return findMethodCalls('createTransaction');
}

// ── Тести ────────────────────────────────────────────────────────────────────────────────

describe('Settlements — місця виклику createTransaction (статичний сторож)', () => {
  const calls = findCreateTransactionCalls();
  const callsByKey = new Map(calls.map(c => [siteKey(c), c]));

  // guards: BR-SETL-010
  it('кожен виклик createTransaction у apps/api/src записаний у переліку з механізмом захисту від повтору', () => {
    const found = calls.map(siteKey).sort();
    const listed = Object.keys(CALL_SITES).sort();

    const unlisted = found.filter(k => !listed.includes(k));
    const stale = listed.filter(k => !found.includes(k));

    expect(
      unlisted,
      'НОВЕ місце виклику createTransaction без запису в CALL_SITES. createTransaction НЕ ідемпотентна ' +
        '(BR-SETL-010): додай запис у settlements.callers.spec.ts і вкажи, чим це місце захищене від ' +
        'подвійного нарахування (CAS статусу в тій самій tx, перевірка наявної проводки, термінальний статус). ' +
        'Захисту немає — познач `unprotected: true`.',
    ).toEqual([]);
    expect(
      stale,
      'Запис у CALL_SITES є, а виклику в коді вже немає (або змінився метод / тип проводки). ' +
        'Прибери чи виправ запис у settlements.callers.spec.ts.',
    ).toEqual([]);
    // Два виклики з однаковим ключем (той самий метод і тип) злились би в один запис — рахуємо окремо.
    expect(found, 'два виклики з однаковим ключем «файл#метод:тип»').toEqual(listed);
  });

  // guards: BR-SETL-010
  it('захист, названий у переліку, справді стоїть у коді ПЕРЕД викликом createTransaction', () => {
    const missing: string[] = [];
    for (const [key, site] of Object.entries(CALL_SITES)) {
      if (site.unprotected) continue;
      const call = callsByKey.get(key);
      if (!call) continue; // про це вже сказав попередній кейс
      expect(site.anchors.length, `${key}: запис без якорів захисту`).toBeGreaterThan(0);

      let scope = call.before;
      if (site.guardedBy) {
        const outer = findMethodCalls(site.guardedBy.calls);
        // Захист у викликачі чогось вартий, лише поки викликач один.
        expect(
          outer.map(c => `${c.file}#${c.method}`),
          `${key}: метод ${site.guardedBy.calls} мусить мати рівно одного викликача (там стоїть захист)`,
        ).toEqual([`${site.guardedBy.file}#${site.guardedBy.method}`]);
        scope = outer[0]?.before ?? '';
      }
      for (const anchor of site.anchors) {
        if (!anchor.test(scope)) missing.push(`${key} — немає перед викликом: ${anchor.source}`);
      }
      for (const anchor of site.argAnchors ?? []) {
        if (!anchor.test(call.callText))
          missing.push(`${key} — немає в аргументах виклику: ${anchor.source}`);
      }
    }
    expect(
      missing,
      'Захист від подвійного нарахування, записаний у CALL_SITES, не знайдено в коді перед викликом ' +
        'createTransaction. Якщо захист прибрано — це порушення BR-SETL-010; якщо код лише переписано — ' +
        'онови якір у settlements.callers.spec.ts.',
    ).toEqual([]);
  });

  // guards: BR-SETL-010
  it('місця виклику, де захисту від повтору не знайдено, — явний перелік (зараз порожній)', () => {
    const unprotected = Object.entries(CALL_SITES)
      .filter(([, site]) => site.unprotected)
      .map(([key]) => key)
      .sort();
    expect(unprotected).toEqual([]);
  });

  // guards: BR-SETL-010
  it('тести гонки / повтору, названі в переліку, справді існують у спеках викликачів', () => {
    const broken: string[] = [];
    for (const [key, site] of Object.entries(CALL_SITES)) {
      for (const race of site.raceTests) {
        const specPath = join(MODULES_DIR, race.spec);
        if (!existsSync(specPath)) {
          broken.push(`${key} — немає файла ${race.spec}`);
          continue;
        }
        if (!readFileSync(specPath, 'utf8').includes(`'${race.title}'`))
          broken.push(`${key} — у ${race.spec} немає кейсу «${race.title}»`);
      }
    }
    expect(
      broken,
      'Тест гонки, на який посилається CALL_SITES, зник або перейменований — онови посилання, ' +
        'а якщо тест видалено, лиши `raceTests: []` і поясни в `note`.',
    ).toEqual([]);
  });

  // Місця без жодного тесту гонки — не помилка, але вони мусять бути названі, а не загублені.
  it('місця виклику без власного тесту гонки — явний перелік', () => {
    const untested = Object.entries(CALL_SITES)
      .filter(([, site]) => site.raceTests.length === 0)
      .map(([key]) => key)
      .sort();
    expect(untested).toEqual([
      'modules/invoices/invoices.service.ts#transition:PAYMENT',
      'modules/work-orders/work-order-stock-effects.service.ts#returnPartsAndCredit:CREDIT_NOTE',
    ]);
    for (const key of untested) expect(CALL_SITES[key].note, key).toBeTruthy();
  });

  // Сторож, що нічого не знаходить, зеленіє завжди — переконуємось, що обхід справді дійшов до
  // чужих модулів і що парсер бачить виклики.
  it('сторож справді обходить код: файлів сотні, викликів createTransaction — не нуль, визначення не рахується', () => {
    const files = collectSourceFiles(SRC_DIR).map(relPath);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('modules/settlements/settlements.service.ts');
    expect(calls.length).toBeGreaterThan(0);
    // Саме визначення `async createTransaction(` — не виклик.
    expect(calls.map(c => c.file)).not.toContain('modules/settlements/settlements.service.ts');
    expect(calls.every(c => c.method !== '<top-level>')).toBe(true);
  });
});
