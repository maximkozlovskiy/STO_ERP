import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

/**
 * СТАТИЧНИЙ сторож критичного правила проєкту (CLAUDE.md «Офлайн-незалежність»):
 *
 *   1. зовнішні API (SMS, ПРРО, прайси) — тільки через BullMQ-чергу;
 *   2. черга з retry — attempts >= 10, backoff exponential; для ПРРО attempts = 288 (24 год).
 *
 * Чому статично: опції ретраїв — літерали в третьому аргументі `queue.add(...)`. Unit-тести сервісів
 * мокають чергу й здебільшого перевіряють `objectContaining({ attempts })` або нічого — до цього
 * файла зміна `backoff.type` черги `checkbox` на 'fixed' не валила жодного тесту, а нову чергу до
 * зовнішнього API можна було додати взагалі без ретраїв.
 *
 * Як працює: TypeScript-парсером обходимо весь `apps/api/src` (без спеків), для кожного класу
 * збираємо `@InjectQueue('<черга>')`-параметри конструктора і всі виклики `this.<черга>.add(...)`;
 * з третього аргументу читаємо `attempts` і `backoff`. Окремо збираємо `registerQueue({ name,
 * defaultJobOptions })`.
 *
 * Сторож НЕ лагодить код. Наявні порушення зафіксовані в KNOWN_VIOLATIONS — щоб ловились НОВІ.
 */

const SRC_DIR = join(__dirname, '..', '..');

/** Черги, чий процесор ходить у зовнішній сервіс: черга → що саме зовні. */
const EXTERNAL_API_QUEUES: Record<string, string> = {
  checkbox: 'ПРРО (Checkbox / Вчасно.Каса)',
  sms: 'SMS / Viber / Email провайдери',
  'outbound-webhook': 'HTTP-endpoint клієнта',
  'payment-polling': 'платіжний шлюз (monobank / LiqPay)',
  'nova-poshta-polling': 'служба доставки (Нова Пошта)',
  'nbu-fetch': 'API курсів НБУ',
  'bank-statement-polling': 'API банку (виписки)',
  'supplier-search': 'API постачальників автозапчастин (перевірка, пошук пропозицій)',
  'supplier-order': 'API постачальників автозапчастин (замовлення, статуси)',
  'supplier-catalog': 'API постачальника (дзеркало каталогу AVD)',
  // Опитування getUpdates власного Telegram-бота (BR-AUT-041); надсилання — черга `sms`.
  'telegram-bot': 'Telegram Bot API (опитування оновлень)',
};

/** Черги, чий процесор працює лише з власною БД/Redis (правило про зовнішні API їх не стосується). */
const INTERNAL_QUEUES = new Set([
  'loyalty', // запис балів у БД
  'followup', // добовий батч: читає БД і ставить job-и в чергу `sms` (сам назовні не ходить)
  'invoice-overdue',
  'reconciliation',
  'idempotency-purge',
  'integration-log-purge',
  'dead-letter-purge',
  // Перепостановка завислих задач постачальників і очищення пропозицій — лише БД і Redis.
  'supplier-maintenance',
  // Outbox подій документів (BR-AUT-061): обробник лише позначає події в БД; зовнішні дії
  // правил ідуть окремими чергами з повторами (BR-AUT-015).
  'automation-events',
]);

const MIN_ATTEMPTS = 10;
const FISCAL_ATTEMPTS = 288;
const FISCAL_BACKOFF_DELAY_MS = 300_000;

/**
 * ВІДОМІ ПОРУШЕННЯ, див. звіт 2026-10-08 (прогалина «повтори черг», docs/TECH-DEBT.md §7).
 * Знайдені цим сторожем при першому запуску; код свідомо НЕ правився — рішення за власником.
 * Ключ: `<файл від apps/api/src>#<метод>`; значення — опції ретраїв, як вони є в коді зараз.
 *
 * Запис тут не «дозвіл»: він лише відділяє старе від нового. Виправив сайт — прибери запис
 * (тест «білий список не містить застарілих записів» про це нагадає).
 */
const KNOWN_VIOLATIONS: Record<string, RetryOpts> = {
  // NBU (nbu-fetch.scheduler) і автопідтягування виписок (bank-statement-pull.scheduler) зі списку
  // прибрано 2026-10-24: attempts 10 + exponential, як вимагає правило (TECH-DEBT §8).

  // відоме порушення, див. звіт: без attempts/backoff. Polling-черги побудовані як self-re-enqueue
  // (процесор сам ставить наступний job із delay), тож BullMQ-ретраїв не мають узагалі (attempts=1).
  'modules/payments/online-payment.service.ts#createIntent': { attempts: null, backoff: null },
  'modules/payments/payment-polling.processor.ts#enqueueNextPoll': {
    attempts: null,
    backoff: null,
  },
  'modules/payments/payment-polling.processor.ts#finalizePayment': {
    attempts: null,
    backoff: null,
  },
  'modules/purchase-orders/delivery/delivery-tracking.service.ts#enqueueInitial': {
    attempts: null,
    backoff: null,
  },
  'modules/purchase-orders/delivery/nova-poshta-polling.processor.ts#reEnqueue': {
    attempts: null,
    backoff: null,
  },
};

interface RetryOpts {
  /** null — ключа немає (BullMQ-дефолт: 1 спроба, без ретраїв). */
  attempts: number | null;
  /** null — ключа немає (BullMQ-дефолт: повтор без затримки). */
  backoff: string | null;
}

interface AddSite extends RetryOpts {
  key: string;
  file: string;
  line: number;
  queue: string;
  backoffDelay: number | null;
}

interface RegisterSite {
  file: string;
  line: number;
  /** null — ім'я не літерал (bull-board реєструє список імен через `.map`). */
  name: string | null;
  defaultJobOptions: string | null;
}

interface ScanResult {
  addSites: AddSite[];
  registerSites: RegisterSite[];
  injectedQueues: Set<string>;
  /** Те, що сторож побачив, але не зміг розібрати — мусить бути порожнім. */
  unresolved: string[];
}

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

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
  }
  return undefined;
}

/**
 * Фабрики задач файлу: `const placeJob = (…) => ({ name, data, opts: {…} })` на рівні модуля — одне
 * джерело опцій для `add()` і `addBulk()` того самого виду задач (simplify 2026-10-21). Сторож судить
 * літерал `opts` фабрики так само, як літерал біля виклику.
 */
type JobFactories = Map<string, ts.ObjectLiteralExpression>;

function collectJobFactories(sf: ts.SourceFile): JobFactories {
  const out: JobFactories = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isArrowFunction(d.initializer))
        continue;
      let body: ts.Node = d.initializer.body;
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (ts.isObjectLiteralExpression(body) && prop(body, 'opts')) out.set(d.name.text, body);
    }
  }
  return out;
}

/** Об'єкт задачі: літерал або виклик фабрики файлу (`placeJob(orgId, id)`). */
function jobLiteral(
  expr: ts.Expression,
  factories: JobFactories,
): ts.ObjectLiteralExpression | undefined {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return factories.get(expr.expression.text);
  }
  return undefined;
}

/**
 * Третій аргумент `add(name, data, opts)`: літерал, або змінна з деструктуризації виклику фабрики в
 * тій самій функції (`const { name, data, opts } = placeJob(…)`).
 */
function addOpts(call: ts.CallExpression, factories: JobFactories): ts.Expression | undefined {
  const arg = call.arguments[2];
  if (!arg || !ts.isIdentifier(arg)) return arg;
  let fn: ts.Node | undefined = call.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  let found: ts.Expression | undefined;
  const find = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      n.name.elements.some(e => e.name.getText() === arg.text && !e.propertyName)
    ) {
      found = prop(
        jobLiteral(n.initializer, factories) ?? ts.factory.createObjectLiteralExpression(),
        arg.text,
      );
    }
    if (!found) ts.forEachChild(n, find);
  };
  if (fn) find(fn);
  return found;
}

/**
 * Опції задач `addBulk(...)`: масив об'єктів-літералів або `xs.map(x => ({ …, opts }))` чи
 * `xs.map(x => fabric(…))`. Усі задачі мусять мати ОДНАКОВИЙ літерал `opts` (інакше сторож не може
 * судити виклик одним сайтом) — тоді повертається він, інакше undefined (виклик іде в нерозібрані).
 */
function bulkJobOpts(
  arg: ts.Expression | undefined,
  factories: JobFactories,
): ts.Expression | undefined {
  if (!arg) return undefined;
  let jobs: ts.Expression[] = [];
  if (ts.isArrayLiteralExpression(arg)) {
    jobs = [...arg.elements];
  } else if (
    ts.isCallExpression(arg) &&
    ts.isPropertyAccessExpression(arg.expression) &&
    arg.expression.name.text === 'map' &&
    arg.arguments[0] &&
    ts.isArrowFunction(arg.arguments[0])
  ) {
    let body: ts.Node = arg.arguments[0].body;
    while (ts.isParenthesizedExpression(body)) body = body.expression;
    if (ts.isExpression(body)) jobs = [body];
  }
  const all = jobs.map(j => {
    const lit = jobLiteral(j, factories);
    return lit ? prop(lit, 'opts') : undefined;
  });
  if (all.length === 0 || all.some(o => !o)) return undefined;
  const first = all[0] as ts.Expression;
  return all.every(o => o?.getText() === first.getText()) ? first : undefined;
}

function enclosingMember(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) {
      return n.name?.getText() ?? '<anonymous>';
    }
    if (ts.isConstructorDeclaration(n)) return 'constructor';
  }
  return '<module>';
}

function scan(): ScanResult {
  const res: ScanResult = {
    addSites: [],
    registerSites: [],
    injectedQueues: new Set(),
    unresolved: [],
  };

  for (const file of collectSourceFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    // Дешевий відсів: парсимо лише файли, де взагалі згадано чергу.
    if (!/InjectQueue|registerQueue|[qQ]ueue\s*\.\s*add/.test(text)) continue;
    const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const factories = collectJobFactories(sf);

    // 1. Властивість класу → ім'я черги (`@InjectQueue('checkbox') private readonly checkboxQueue`).
    const queueByProp = new Map<string, string>();
    const collectInjected = (node: ts.Node): void => {
      if (ts.isParameter(node)) {
        for (const d of ts.getDecorators(node) ?? []) {
          const call = d.expression;
          if (ts.isCallExpression(call) && call.expression.getText(sf) === 'InjectQueue') {
            const arg = call.arguments[0];
            if (arg && ts.isStringLiteralLike(arg)) {
              queueByProp.set(node.name.getText(sf), arg.text);
              res.injectedQueues.add(arg.text);
            } else {
              res.unresolved.push(`${rel}:${lineOf(node)} — @InjectQueue з не-літеральним іменем`);
            }
          }
        }
      }
      ts.forEachChild(node, collectInjected);
    };
    collectInjected(sf);

    // 2. Виклики `.add(...)` на чергах і `registerQueue(...)`.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;

        if (method === 'registerQueue') {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) {
              res.unresolved.push(
                `${rel}:${lineOf(node)} — registerQueue з не-літеральним аргументом`,
              );
              continue;
            }
            const nameExpr = prop(arg, 'name');
            const defaults = prop(arg, 'defaultJobOptions');
            res.registerSites.push({
              file: rel,
              line: lineOf(arg),
              name: nameExpr && ts.isStringLiteralLike(nameExpr) ? nameExpr.text : null,
              defaultJobOptions: defaults ? defaults.getText(sf) : null,
            });
          }
        }

        const receiverText = receiver.getText(sf);
        const isQueueProp =
          ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
          queueByProp.has(receiver.name.text);

        if (['add', 'addBulk', 'upsertJobScheduler'].includes(method)) {
          if (isQueueProp) {
            const queue = queueByProp.get(
              (receiver as ts.PropertyAccessExpression).name.text,
            ) as string;
            const where = `${rel}:${lineOf(node)}`;
            // addBulk([...]) / addBulk(xs.map(x => ({ …, opts: {…} }))): опції КОЖНОЇ задачі —
            // той самий літерал, що й третій аргумент add() (supplier-search, optimize 2026-10-18).
            const opts =
              method === 'addBulk'
                ? bulkJobOpts(node.arguments[0], factories)
                : addOpts(node, factories);
            if (method === 'upsertJobScheduler') {
              res.unresolved.push(
                `${where} — ${method}() на черзі '${queue}': сторож його не вміє`,
              );
            } else if (!opts || !ts.isObjectLiteralExpression(opts)) {
              res.unresolved.push(`${where} — ${method}() на черзі '${queue}' без літерала опцій`);
            } else {
              const attempts = prop(opts, 'attempts');
              const backoff = prop(opts, 'backoff');
              let attemptsVal: number | null = null;
              let backoffType: string | null = null;
              let backoffDelay: number | null = null;
              if (attempts) {
                if (ts.isNumericLiteral(attempts)) attemptsVal = Number(attempts.text);
                else res.unresolved.push(`${where} — attempts не числовий літерал`);
              }
              if (backoff) {
                const type = ts.isObjectLiteralExpression(backoff) ? prop(backoff, 'type') : null;
                const delay = ts.isObjectLiteralExpression(backoff) ? prop(backoff, 'delay') : null;
                if (type && ts.isStringLiteralLike(type)) backoffType = type.text;
                else res.unresolved.push(`${where} — backoff.type не рядковий літерал`);
                if (delay && ts.isNumericLiteral(delay)) backoffDelay = Number(delay.text);
              }
              res.addSites.push({
                key: `${rel}#${enclosingMember(node)}`,
                file: rel,
                line: lineOf(node),
                queue,
                attempts: attemptsVal,
                backoff: backoffType,
                backoffDelay,
              });
            }
          } else if (/queue/i.test(receiverText)) {
            // Щось, що називається чергою, але не є `this.<@InjectQueue-властивість>` — сторож
            // не знає її імені, тож не може її судити. Краще впасти, ніж мовчки пропустити.
            res.unresolved.push(
              `${rel}:${lineOf(node)} — ${receiverText}.${method}(): чергу не вдалося зіставити з @InjectQueue`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return res;
}

const describeSite = (s: AddSite): string =>
  `${s.file}:${s.line} [${s.queue}] attempts=${s.attempts ?? 'немає'} backoff=${s.backoff ?? 'немає'}`;

const breaksRule = (s: RetryOpts): boolean =>
  s.attempts === null || s.attempts < MIN_ATTEMPTS || s.backoff !== 'exponential';

describe('Політика повторів черг зовнішніх API (статичний сторож, CLAUDE.md «Офлайн-незалежність»)', () => {
  const found = scan();
  const externalSites = found.addSites.filter(s => s.queue in EXTERNAL_API_QUEUES);

  it('сторож бачить код: перепис add()-сайтів зовнішніх черг збігається, нерозібраних викликів немає', () => {
    // Захист від «зеленого, бо нічого не знайшов»: якщо парсер перестане бачити виклик (чергу
    // сховали за локальну змінну, перейменували @InjectQueue) — решта тестів файла мовчки
    // судила б менше сайтів. Додав новий add() у зовнішню чергу — онови число тут: це свідомий
    // крок, заодно перевір його attempts/backoff.
    expect(found.unresolved).toEqual([]);
    const census: Record<string, number> = {};
    for (const s of externalSites) census[s.queue] = (census[s.queue] ?? 0) + 1;
    expect(census).toEqual({
      checkbox: 2,
      sms: 2,
      'outbound-webhook': 1,
      'payment-polling': 3,
      'nova-poshta-polling': 2,
      'nbu-fetch': 3,
      'bank-statement-polling': 2,
      'supplier-search': 2,
      'supplier-catalog': 3,
      'supplier-order': 4,
      'telegram-bot': 1,
    });
    expect(found.registerSites.filter(r => r.name !== null).length).toBeGreaterThanOrEqual(14);
  });

  it('кожна черга з коду класифікована: зовнішнє API або внутрішня (нова черга змушує вирішити)', () => {
    const named = [
      ...found.injectedQueues,
      ...found.registerSites.map(r => r.name).filter((n): n is string => n !== null),
    ];
    const unclassified = [...new Set(named)].filter(
      q => !(q in EXTERNAL_API_QUEUES) && !INTERNAL_QUEUES.has(q),
    );
    expect(unclassified).toEqual([]);
    // І навпаки: у списках немає черг, яких у коді вже нема.
    const stale = [...Object.keys(EXTERNAL_API_QUEUES), ...INTERNAL_QUEUES].filter(
      q => !named.includes(q),
    );
    expect(stale).toEqual([]);
  });

  it(`ПРРО: кожен add() у чергу checkbox — attempts=${FISCAL_ATTEMPTS} + exponential backoff від 5 хв (ретраї ~24 год, поки каса чи інтернет недоступні)`, () => {
    const fiscal = found.addSites.filter(s => s.queue === 'checkbox');
    expect(fiscal.length).toBeGreaterThan(0);
    for (const s of fiscal) {
      expect(
        { attempts: s.attempts, backoff: s.backoff, delay: s.backoffDelay },
        describeSite(s),
      ).toEqual({
        attempts: FISCAL_ATTEMPTS,
        backoff: 'exponential',
        delay: FISCAL_BACKOFF_DELAY_MS,
      });
    }
  });

  it(`жодна черга зовнішнього API не має attempts < ${MIN_ATTEMPTS} чи не-exponential backoff — крім відомих порушень із білого списку`, () => {
    const fresh = externalSites
      .filter(breaksRule)
      .filter(s => !(s.key in KNOWN_VIOLATIONS))
      .map(describeSite);
    expect(fresh).toEqual([]);
  });

  it('білий список не містить застарілих записів: кожен запис — досі порушення і з тими самими опціями', () => {
    const drift: string[] = [];
    for (const [key, expected] of Object.entries(KNOWN_VIOLATIONS)) {
      const sites = externalSites.filter(s => s.key === key);
      if (sites.length === 0) {
        drift.push(`${key} — такого add() більше немає: прибери запис`);
        continue;
      }
      for (const s of sites) {
        if (!breaksRule(s)) {
          drift.push(`${key} — виправлено (${describeSite(s)}): прибери запис`);
        } else if (s.attempts !== expected.attempts || s.backoff !== expected.backoff) {
          drift.push(
            `${key} — опції змінились: у списку ${JSON.stringify(expected)}, у коді ${describeSite(s)}`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('registerQueue: defaultJobOptions — лише спільний DEFAULT_JOB_OPTS, а він не задає attempts/backoff: політика ретраїв живе в кожному add()', () => {
    // Якби хтось задав attempts у дефолтах черги, add() без attempts перестав би бути порушенням
    // (успадкував би дефолт), а сторож вище судив би його хибно. Тому дефолти — лише retention.
    expect(DEFAULT_JOB_OPTS).toEqual({ removeOnComplete: true, removeOnFail: 200 });
    const custom = found.registerSites
      .filter(r => r.defaultJobOptions !== null && r.defaultJobOptions !== 'DEFAULT_JOB_OPTS')
      .map(r => `${r.file}:${r.line} — defaultJobOptions: ${r.defaultJobOptions}`);
    expect(custom).toEqual([]);
  });
});
