import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';

/**
 * Метадата-реєстр конструктора звітів — ЄДИНЕ ДЖЕРЕЛО ПРАВДИ.
 *
 * Описує, які сутності/поля/зв'язки/агрегації дозволені у звітах. Живить і backend-білдер
 * (report-query.builder), і frontend-каталог (GET /reports/builder/metadata).
 *
 * БЕЗПЕКА: користувач передає лише `field.key` (публічний id). Він резолвиться у реєстровий
 * `prismaPath` — ЛІТЕРАЛ у цьому файлі, ніколи не з вводу. Усі helper-и використовують
 * `Object.prototype.hasOwnProperty.call` (як buildSortOrderBy у pagination.ts) — захист від
 * prototype-injection (`__proto__`/`constructor`/`toString`). Значення фільтрів параметризує
 * Prisma-клієнт. Отже generated-SQL-injection неможливий за побудовою.
 */

export type Agg = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export const ALLOWED_AGGS: readonly Agg[] = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];

export type FilterOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull';
export const ALLOWED_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'isNull',
];

/** scalar — рядок/id; number — Float/Int; decimal — грошове; enum — з whitelist; date; relation — леґасі-мітка. */
export type FieldType = 'scalar' | 'number' | 'decimal' | 'enum' | 'date' | 'boolean';

export interface ReportFieldDef {
  /** Публічний id, стабільний. Для relation-поля — dot-path, напр. 'counterparty.type'. */
  key: string;
  label: string;
  type: FieldType;
  /** Dot-path у Prisma-моделі: 'quantity' | 'counterparty.type' | 'good.brand.name'. */
  prismaPath: string;
  /** Для type:'enum' — ключ у REGISTRY.enums (валідація значень фільтра + рендер). */
  enumName?: string;
  /** Дозволені агрегації (порожньо = поле не агрегабельне, лише для колонок/групування). */
  aggregations: Agg[];
  filterable: boolean;
  groupable: boolean;
  /** balance тощо — стан, не потік: SUM заборонено (лише AVG/MIN/MAX). */
  stateNotFlow?: boolean;
  /** Знакове поле (StockMovement.quantity): знак береться з сусіднього enum-поля (напр. 'type'). */
  signedByType?: string;
  /** Колонка `@db.Date` (дата без часу): межі дня — сама дата, а не київська доба. Prisma зводить
   *  параметр до типу колонки, тож київська межа «з 20.10» (19.10 21:00 UTC) ставала 19.10. */
  dateOnly?: boolean;
  /** Колонка допускає NULL — лише тоді доречні «порожнє / заповнене» (інакше 400 з назвою поля).
   *  Звіряється зі схемою Prisma у `report-registry.spec.ts`. */
  nullable?: boolean;
}

export interface ReportRelationDef {
  /** dot-path гілки: 'counterparty' | 'good.brand' | 'purchaseOrder.supplier'. */
  key: string;
  label: string;
  /** prismaModel цільової сутності (довідково). */
  target: string;
  prismaPath: string;
  /** Фактична глибина ланцюга (кількість хопів). */
  depth: number;
  /** 3+ хопи або дубль — сховати за замовчуванням у UI. */
  advanced: boolean;
  /** Чи інжектити deletedAt:null у nested include на цьому хопі (Bug #607). */
  targetHasSoftDelete: boolean; /** FK-колонка в таблиці батька (SQL-агрегати); типово `<зв'язок>Id`. */
  fk: string;
}

export type EntityProfile = 'FULL' | 'APPEND_ONLY';

export interface ReportEntityDef {
  key: string;
  /** Ім'я Prisma-делегата: this.prisma[prismaModel].findMany(...). */
  prismaModel: string;
  tableName: string;
  label: string;
  profile: EntityProfile;
  /** FULL → true (інжектимо deletedAt:null); APPEND_ONLY → false (поля немає). */
  hasSoftDelete: boolean;
  /** Поле для dateRange-фільтра. */
  dateField: string;
  /** Зв'язки, без живого кінця яких рядок не існує для звіту: документ-власник (наряд, закупівля)
   *  або товар і склад залишку. Видалення позначає лише сам документ / товар / склад, рядки
   *  лишаються з `deletedAt: null` — тому умова `deletedAt: null` ставиться і на кожен із них. */
  parentRelations?: readonly string[];
  /** Позначка сторно append-only рядка (`payment.reversedAt`): заповнена — рядок уже не діє, тож
   *  за замовчуванням не входить у звіт, як і в решті підсумків застосунку. Фільтр користувача по
   *  цьому полю (порожнє / заповнене / дата) замінює умову за замовчуванням. */
  voidedField?: string;
  defaultSort: { path: string; dir: 'asc' | 'desc' };
  fields: ReportFieldDef[];
  relations: ReportRelationDef[];
}

// ─── ENUM whitelists ────────────────────────────────────────────────────────────
export const REGISTRY_ENUMS: Record<string, readonly string[]> = {
  CounterpartyType: ['CLIENT', 'SUPPLIER', 'BOTH'],
  WorkOrderStatus: [
    'DRAFT',
    'ESTIMATE',
    'APPROVED',
    'IN_PROGRESS',
    'ON_HOLD',
    'COMPLETED',
    'INVOICED',
    'PAID',
    'ARCHIVED',
    'CANCELLED',
  ],
  WorkOrderPriority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
  PurchaseOrderStatus: ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
  InvoiceStatus: ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'],
  SettlementTransactionType: [
    'CHARGE',
    'PAYMENT',
    'REFUND',
    'PREPAYMENT',
    'CREDIT_NOTE',
    'SUPPLIER_CHARGE',
    'SUPPLIER_PAYMENT',
    'SUPPLIER_REFUND',
    'FX_GAIN',
    'FX_LOSS',
    'REFUND_OUT',
    'REFUND_OUT_CANCEL',
    'SUPPLIER_PAYMENT_RETURN',
    'PAYMENT_CANCEL',
    'PREPAYMENT_CANCEL',
    'SUPPLIER_PAYMENT_CANCEL',
    'SUPPLIER_PAYMENT_RETURN_CANCEL',
  ],
  StockMovementType: [
    'RECEIPT',
    'WRITEOFF',
    'TRANSFER',
    'RESERVATION',
    'RESERVATION_RELEASE',
    'OPENING_BALANCE',
    'RETURN',
  ],
  GoodType: ['SPARE_PART', 'CONSUMABLE', 'MATERIAL', 'TOOL'],
};

// ─── Фабрики полів: типові види полів описані один раз ──────────────────────────
// key збігається з prismaPath у всіх полях реєстру; фільтрувати можна кожне поле фабрики.

/** Текст / ідентифікатор (зокрема поле зв'язку `good.name`): групується, не агрегується. */
const textField = (key: string, label: string): ReportFieldDef => ({
  key,
  label,
  type: 'scalar',
  prismaPath: key,
  aggregations: [],
  filterable: true,
  groupable: true,
});

/** Перелік: значення фільтра звіряється з REGISTRY_ENUMS[enumName]. */
const enumField = (key: string, label: string, enumName: string): ReportFieldDef => ({
  key,
  label,
  type: 'enum',
  prismaPath: key,
  enumName,
  aggregations: [],
  filterable: true,
  groupable: true,
});

/** Дата: MIN/MAX, групування за київським днем; `dateOnly` — колонка `@db.Date`. */
const dateField = (
  key: string,
  label: string,
  opts: { groupable?: boolean; dateOnly?: boolean } = {},
): ReportFieldDef => ({
  key,
  label,
  type: 'date',
  prismaPath: key,
  aggregations: ['MIN', 'MAX'],
  filterable: true,
  groupable: opts.groupable ?? true,
  ...(opts.dateOnly ? { dateOnly: true } : {}),
});

/** Сума чи кількість, що складається: SUM/AVG/MIN/MAX (авто-SUM у колонці, BR-RPT-012). */
const sumField = (
  key: string,
  label: string,
  type: 'decimal' | 'number' = 'decimal',
): ReportFieldDef => ({
  key,
  label,
  type,
  prismaPath: key,
  aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
  filterable: true,
  groupable: false,
});

/** Ціна / ставка / поріг: без SUM — сума цін не є ціною, і склеювання її не складає (BR-RPT-015). */
const rateField = (
  key: string,
  label: string,
  type: 'decimal' | 'number' = 'decimal',
): ReportFieldDef => ({
  key,
  label,
  type,
  prismaPath: key,
  aggregations: ['AVG', 'MIN', 'MAX'],
  filterable: true,
  groupable: false,
});

/** Зв'язок: prismaPath = key, глибина = кількість хопів; цільова сутність типово має soft delete. */
const relation = (
  key: string,
  label: string,
  target: string,
  opts: { targetHasSoftDelete?: boolean; fk?: string } = {},
): ReportRelationDef => ({
  key,
  label,
  target,
  prismaPath: key,
  depth: key.split('.').length,
  advanced: false,
  targetHasSoftDelete: opts.targetHasSoftDelete ?? true,
  fk: opts.fk ?? `${key.split('.').pop()}Id`,
});

/** Поле, колонка якого допускає NULL (див. `ReportFieldDef.nullable`). */
const nullable = (f: ReportFieldDef): ReportFieldDef => ({ ...f, nullable: true });

// ─── Entity definitions (v1: 3 сутності; реєстр розширюваний) ────────────────────

const workOrder: ReportEntityDef = {
  key: 'workOrder',
  prismaModel: 'workOrder',
  tableName: 'work_orders',
  label: 'Наряди',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'documentDate',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    textField('number', 'Номер'),
    enumField('status', 'Статус', 'WorkOrderStatus'),
    enumField('priority', 'Пріоритет', 'WorkOrderPriority'),
    // BR-RPT-023 / BR-WO-007: три однозначні суми наряду — без ПДВ, ПДВ, до сплати (з ПДВ).
    sumField('totalNet', 'Сума (без ПДВ)'),
    sumField('totalAmount', 'Сума з ПДВ'),
    sumField('totalLabor', 'Роботи'),
    sumField('totalParts', 'Запчастини'),
    sumField('totalVat', 'ПДВ'),
    sumField('paidAmount', 'Оплачено'),
    nullable(dateField('completedAt', 'Завершено')),
    dateField('documentDate', 'Дата', { dateOnly: true }),
    // relation-колонки (рівень 1 — прямий шлях WO→CP, рекомендований):
    enumField('counterparty.type', 'Тип контрагента', 'CounterpartyType'),
    nullable(textField('counterparty.companyName', 'Контрагент')),
    textField('branch.name', 'Філія'),
    textField('vehicle.make', 'Авто (марка)'),
    nullable(textField('vehicle.licensePlate', 'Авто (номер)')),
  ],
  relations: [
    relation('counterparty', 'Контрагент', 'counterparty'),
    relation('branch', 'Філія', 'garageBranch'),
    relation('vehicle', 'Авто', 'vehicle'),
  ],
};

const workOrderPart: ReportEntityDef = {
  key: 'workOrderPart',
  prismaModel: 'workOrderPart',
  tableName: 'work_order_parts',
  label: 'Запчастини у нарядах',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'createdAt',
  parentRelations: ['workOrder'],
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    sumField('quantity', 'Кількість', 'number'),
    rateField('price', 'Ціна'),
    sumField('amount', 'Сума'),
    nullable(sumField('batchCostPrice', 'Собівартість')),
    // relation-колонки (good рівень 1, good→brand рівень 2 — зрозумілий ланцюг):
    textField('good.name', 'Товар'),
    nullable(textField('good.sku', 'SKU')),
    textField('good.brand.name', 'Бренд'),
    textField('warehouse.name', 'Склад'),
    textField('workOrder.number', 'Наряд'),
    nullable(textField('workOrder.counterparty.companyName', 'Контрагент')),
    enumField('workOrder.counterparty.type', 'Тип контрагента', 'CounterpartyType'),
  ],
  relations: [
    relation('good', 'Товар', 'good'),
    relation('good.brand', 'Бренд', 'brand'),
    relation('warehouse', 'Склад', 'warehouse'),
    relation('workOrder', 'Наряд', 'workOrder'),
    relation('workOrder.counterparty', 'Контрагент (наряду)', 'counterparty'),
  ],
};

const purchaseOrderLine: ReportEntityDef = {
  key: 'purchaseOrderLine',
  prismaModel: 'purchaseOrderLine',
  tableName: 'purchase_order_lines',
  label: 'Рядки закупівель',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'createdAt',
  parentRelations: ['purchaseOrder'],
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    sumField('quantity', 'Кількість', 'number'),
    rateField('price', 'Ціна'),
    sumField('vatAmount', 'ПДВ'),
    sumField('receivedQty', 'Отримано', 'number'),
    textField('good.name', 'Товар'),
    nullable(textField('good.sku', 'SKU')),
    textField('good.brand.name', 'Бренд'),
    textField('purchaseOrder.number', 'Закупівля'),
    enumField('purchaseOrder.status', 'Статус', 'PurchaseOrderStatus'),
    nullable(textField('purchaseOrder.supplier.companyName', 'Постачальник')),
    enumField('purchaseOrder.supplier.type', 'Тип постачальника', 'CounterpartyType'),
  ],
  relations: [
    relation('good', 'Товар', 'good'),
    relation('good.brand', 'Бренд', 'brand'),
    relation('purchaseOrder', 'Закупівля', 'purchaseOrder'),
    relation('purchaseOrder.supplier', 'Постачальник', 'counterparty'),
  ],
};

// ── Invoice (рахунки) ──────────────────────────────────────────────────────────
const invoice: ReportEntityDef = {
  key: 'invoice',
  prismaModel: 'invoice',
  tableName: 'invoices',
  label: 'Рахунки',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'documentDate',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    textField('number', 'Номер'),
    enumField('status', 'Статус', 'InvoiceStatus'),
    sumField('amount', 'Сума'),
    sumField('totalWithoutVat', 'Без ПДВ'),
    sumField('totalVat', 'ПДВ'),
    sumField('totalWithVat', 'З ПДВ'),
    dateField('documentDate', 'Дата', { dateOnly: true }),
    nullable(dateField('dueDate', 'Термін оплати')),
    nullable(textField('counterparty.companyName', 'Контрагент')),
    enumField('counterparty.type', 'Тип контрагента', 'CounterpartyType'),
    textField('workOrder.number', 'Наряд'),
  ],
  relations: [
    relation('counterparty', 'Контрагент', 'counterparty'),
    relation('workOrder', 'Наряд', 'workOrder'),
  ],
};

// ── Payment (платежі клієнтів) — APPEND-ONLY (без deletedAt) ─────────────────────
const payment: ReportEntityDef = {
  key: 'payment',
  prismaModel: 'payment',
  tableName: 'payments',
  label: 'Платежі клієнтів',
  profile: 'APPEND_ONLY',
  hasSoftDelete: false,
  dateField: 'createdAt',
  // BR-CASH-024: сторнована оплата лишається в таблиці (append-only), але вже не «гроші в касі» —
  // рахунки, звірка й лояльність її не рахують, тож і звіт за замовчуванням (BR-RPT-026).
  voidedField: 'reversedAt',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    sumField('amount', 'Сума'),
    textField('method', 'Спосіб'),
    dateField('createdAt', 'Дата'),
    nullable(dateField('reversedAt', 'Сторновано', { groupable: false })),
    nullable(textField('counterparty.companyName', 'Контрагент')),
    enumField('counterparty.type', 'Тип контрагента', 'CounterpartyType'),
    textField('workOrder.number', 'Наряд'),
  ],
  relations: [
    relation('counterparty', 'Контрагент', 'counterparty'),
    relation('workOrder', 'Наряд', 'workOrder'),
  ],
};

// ── SettlementTransaction (взаєморозрахунки) — APPEND-ONLY ───────────────────────
// counterparty через account.counterparty (2 хопи, семантично «рівень 1»).
const settlementTransaction: ReportEntityDef = {
  key: 'settlementTransaction',
  prismaModel: 'settlementTransaction',
  tableName: 'settlement_transactions',
  label: 'Розрахунки (транзакції)',
  profile: 'APPEND_ONLY',
  hasSoftDelete: false,
  dateField: 'createdAt',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    enumField('type', 'Тип', 'SettlementTransactionType'),
    sumField('amount', 'Сума'),
    nullable(textField('documentType', 'Тип документа')),
    dateField('createdAt', 'Дата'),
    nullable(textField('account.counterparty.companyName', 'Контрагент')),
    enumField('account.counterparty.type', 'Тип контрагента', 'CounterpartyType'),
  ],
  relations: [
    relation('account', 'Рахунок', 'settlementAccount', {
      targetHasSoftDelete: false,
      fk: 'settlementAccountId',
    }),
    relation('account.counterparty', 'Контрагент', 'counterparty'),
  ],
};

// ── StockMovement (рухи товару) — APPEND-ONLY, знакова quantity ──────────────────
const stockMovement: ReportEntityDef = {
  key: 'stockMovement',
  prismaModel: 'stockMovement',
  tableName: 'stock_movements',
  label: 'Рухи товару',
  profile: 'APPEND_ONLY',
  hasSoftDelete: false,
  dateField: 'createdAt',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    enumField('type', 'Тип руху', 'StockMovementType'),
    // quantity знакова: SUM дає нетто ФІЗИЧНИЙ рух (RECEIPT/OPENING_BALANCE +, WRITEOFF −).
    // RESERVATION/RESERVATION_RELEASE виключені з нетто (Bug #619) — вони не фізичні рухи,
    // а лічильник резерву (див. inventory.service.ts:187-190). При групуванні по type їхні
    // бакети покажуть SUM_quantity=0.
    // filterable:false — фільтр по знаковому quantity вводить в оману (фільтр бере СИРЕ
    // значення з БД, а SUM показує НЕТТО з правилами above → quantity>0 пропускає WRITEOFF,
    // quantity<0 дає порожньо). Для «лише прихід/списання» — фільтр/групування по `type`.
    {
      key: 'quantity',
      label: 'Кількість (нетто)',
      type: 'number',
      prismaPath: 'quantity',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: false,
      groupable: false,
      signedByType: 'type',
    },
    nullable(rateField('price', 'Ціна')),
    nullable(textField('documentType', 'Тип документа')),
    dateField('createdAt', 'Дата'),
    textField('good.name', 'Товар'),
    textField('good.brand.name', 'Бренд'),
    textField('warehouse.name', 'Склад'),
  ],
  relations: [
    relation('good', 'Товар', 'good'),
    relation('good.brand', 'Бренд', 'brand'),
    relation('warehouse', 'Склад', 'warehouse'),
  ],
};

// ── StockBatch (партії — собівартість/залишки партій) ────────────────────────────
const stockBatch: ReportEntityDef = {
  key: 'stockBatch',
  prismaModel: 'stockBatch',
  tableName: 'stock_batches',
  label: 'Партії товару',
  // StockBatch НЕ має deletedAt (деактивація через isActive, не soft-delete).
  profile: 'APPEND_ONLY',
  hasSoftDelete: false,
  dateField: 'createdAt',
  parentRelations: ['good', 'warehouse'],
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    sumField('receivedQty', 'Отримано', 'number'),
    sumField('remainingQty', 'Залишок', 'number'),
    rateField('costPrice', 'Собівартість'),
    rateField('salePrice', 'Ціна продажу'),
    {
      key: 'isActive',
      label: 'Активна',
      type: 'boolean',
      prismaPath: 'isActive',
      aggregations: [],
      filterable: true,
      groupable: true,
    },
    nullable(dateField('expiryDate', 'Термін придатності')),
    textField('good.name', 'Товар'),
    textField('good.brand.name', 'Бренд'),
    textField('warehouse.name', 'Склад'),
  ],
  relations: [
    relation('good', 'Товар', 'good'),
    relation('good.brand', 'Бренд', 'brand'),
    relation('warehouse', 'Склад', 'warehouse'),
  ],
};

// ── StockItem (поточні залишки) ──────────────────────────────────────────────────
const stockItem: ReportEntityDef = {
  key: 'stockItem',
  prismaModel: 'stockItem',
  tableName: 'stock_items',
  label: 'Залишки на складі',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'createdAt',
  parentRelations: ['good', 'warehouse'],
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    sumField('quantity', 'Кількість', 'number'),
    sumField('reserved', 'Зарезервовано', 'number'),
    nullable(rateField('minStock', 'Мін. запас', 'number')),
    textField('good.name', 'Товар'),
    nullable(textField('good.sku', 'SKU')),
    textField('good.brand.name', 'Бренд'),
    textField('warehouse.name', 'Склад'),
  ],
  relations: [
    relation('good', 'Товар', 'good'),
    relation('good.brand', 'Бренд', 'brand'),
    relation('warehouse', 'Склад', 'warehouse'),
  ],
};

export const REGISTRY: Record<string, ReportEntityDef> = {
  workOrder,
  workOrderPart,
  purchaseOrderLine,
  invoice,
  payment,
  settlementTransaction,
  stockMovement,
  stockBatch,
  stockItem,
};

// ─── Helper-и (усі з hasOwnProperty-guard) ──────────────────────────────────────

export function getEntity(key: string): ReportEntityDef {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(REGISTRY, key)) {
    throw new BadRequestException(
      translateError('err.reportBuilder.unknownEntity', getLocale(), { key: String(key) }),
    );
  }
  return REGISTRY[key];
}

export function getField(entity: ReportEntityDef, key: string): ReportFieldDef {
  const field = entity.fields.find(f => f.key === key);
  if (!field) {
    throw new BadRequestException(
      translateError('err.reportBuilder.unknownField', getLocale(), {
        key: String(key),
        entity: entity.label,
      }),
    );
  }
  return field;
}

/**
 * Для relation-поля (prismaPath з крапкою) перевіряє, що ланцюг зв'язків дозволений реєстром:
 * кожен prefix шляху має бути присутній у relations[]. Повертає relation-def для найглибшого хопа.
 */
export function assertRelationPath(entity: ReportEntityDef, prismaPath: string): void {
  if (!prismaPath.includes('.')) return; // scalar кореня — нема relation
  const segments = prismaPath.split('.');
  // усі prefix-и крім останнього сегмента (leaf) мають бути валідними relation-гілками
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    const rel = entity.relations.find(r => r.prismaPath === prefix);
    if (!rel) {
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedRelation', getLocale(), { prefix }),
      );
    }
  }
}

/** Чи поле за цим шляхом — колонка `@db.Date` (див. `ReportFieldDef.dateOnly`). */
export function isDateOnlyPath(entity: ReportEntityDef, prismaPath: string): boolean {
  return entity.fields.some(f => f.prismaPath === prismaPath && f.dateOnly === true);
}

export function relationForPrefix(
  entity: ReportEntityDef,
  prefix: string,
): ReportRelationDef | undefined {
  return entity.relations.find(r => r.prismaPath === prefix);
}

export function assertEnumValue(enumName: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY_ENUMS, enumName)) {
    throw new BadRequestException(
      translateError('err.reportBuilder.unknownEnum', getLocale(), { enumName }),
    );
  }
  const allowed = REGISTRY_ENUMS[enumName];
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (!allowed.includes(String(v))) {
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedEnumValue', getLocale(), {
          value: String(v),
          enumName,
        }),
      );
    }
  }
}
