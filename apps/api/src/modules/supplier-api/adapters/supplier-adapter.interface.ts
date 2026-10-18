import type { SupplierOrderStatus, SupplierProvider } from '@prisma/client';

/**
 * Контракт адаптера API постачальника (BR-SCON-003, BR-SOFR-001). Адаптер знає протокол
 * постачальника й нічого — про БД, черги й наші документи: на вхід — підключення з розшифрованими
 * кредами й запит, на вихід — нормалізовані пропозиції / стан замовлення. Повтори, звірку,
 * запис кроків і статусів робить обробник черги.
 */

/** Опис поля форми підключення: склад полів приходить у web із сервера (`GET /supplier-providers`). */
export interface SupplierFieldSpec {
  key: string;
  label: string;
  /** Секрет — лише на запис, назовні не віддається (BR-SCON-002). */
  secret: boolean;
  required: boolean;
  type: 'string' | 'boolean' | 'select';
  options?: string[];
  hint?: string;
}

export interface SupplierCapabilities {
  /** online — пошук у API за артикулом; mirror — по локальному дзеркалу каталогу (AVD). */
  search: 'online' | 'mirror';
  analogs: boolean;
  /** Замовлення — одним викликом (direct) чи через кошик (cart). */
  order: 'direct' | 'cart';
  /** Є тестовий режим / пісочниця. */
  sandbox: boolean;
  /** Зовнішнє замовлення — окреме на кожен склад постачальника. */
  orderPerWarehouse: boolean;
  /** Відправка вимагає параметрів доставки для нашого складу (`options.warehouses[<склад>]`). */
  requiresWarehouseMapping: boolean;
}

/** Несекретні параметри підключення: мапа «наш склад → параметри доставки» + інше. */
export interface SupplierConnectionOptions {
  warehouses?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

/** Підключення з розшифрованими кредами — лише в пам'яті обробника, не в job.data. */
export interface SupplierConnectionContext {
  id: string;
  orgId: string;
  counterpartyId: string;
  provider: SupplierProvider;
  apiUrl: string | null;
  testMode: boolean;
  credentials: Record<string, string>;
  options: SupplierConnectionOptions;
}

export interface SupplierSearchQuery {
  article: string;
  brand: string | null;
  includeAnalogs: boolean;
}

/** BR-SOFR-001: нормалізована пропозиція. */
export interface NormalizedOffer {
  supplierItemId: string;
  article: string;
  brand: string | null;
  name: string | null;
  price: number;
  currencyCode: string;
  qty: number;
  /** Постачальник показав межу («>10», «MORE»): qty — нижня межа. */
  qtyIsLowerBound: boolean;
  warehouseCode: string | null;
  warehouseName: string | null;
  deliveryDays: number | null;
  deliveryDate: Date | null;
  multiplicity: number | null;
  /** Постачальник сам позначив пропозицію як аналог/крос. */
  isAnalog: boolean;
  /** Те, що потрібно постачальнику для замовлення (товар + склад / прайс). */
  offerKey: string;
}

/** Рядок дзеркала каталогу (AVD). */
export interface CatalogMirrorRow {
  supplierItemId: string;
  article: string;
  brand: string | null;
  name: string | null;
  price: number;
  currencyCode: string;
  priceType: string | null;
  stock: Array<{
    warehouseCode: string;
    warehouseName: string | null;
    qty: number;
    isCapped: boolean;
  }>;
}

export interface CatalogSink {
  upsert(rows: CatalogMirrorRow[]): Promise<void>;
}

export interface SupplierOrderLineInput {
  lineId: string;
  supplierItemId: string;
  offerKey: string;
  warehouseCode: string | null;
  qty: number;
  price: number;
  currencyCode: string;
}

/** Заморожений план зовнішнього замовлення (SupplierOrder + рядки). */
export interface SupplierOrderInput {
  id: string;
  /** Наш ключ ідемпотентності — у коментарі / номері замовлення постачальника (BR-SCON-011). */
  reference: string;
  purchaseOrderNumber: string;
  supplierWarehouseCode: string | null;
  /** Наш склад, на який їде товар — ключ мапи `options.warehouses`. */
  ourWarehouseId: string;
  lines: SupplierOrderLineInput[];
  sentAt: Date | null;
}

export interface SupplierOrderState {
  step: string | null;
  externalCartId: string | null;
  externalOrderId: string | null;
  externalNumber: string | null;
}

/**
 * Виконавець кроків, який дає обробник. Крок записується в `SupplierOrder.step` ДО наступного;
 * завершений крок при повторі задачі пропускається. Неповторюваний крок перед викликом
 * позначається `<крок>:PENDING`; неоднозначна відмова (тайм-аут, 5xx) → крок RECONCILE.
 */
export interface PlaceOrderRunner {
  readonly state: SupplierOrderState;
  step(
    name: string,
    opts: { repeatable: boolean },
    fn: () => Promise<Partial<SupplierOrderState> | void>,
  ): Promise<void>;
}

export interface ConfirmedLine {
  supplierItemId: string;
  warehouseCode?: string | null;
  qtyConfirmed: number;
  priceConfirmed?: number | null;
  statusRaw?: string | null;
  externalLineId?: string | null;
}

export interface PlacedOrderResult {
  status: SupplierOrderStatus;
  statusRaw: string | null;
  lines?: ConfirmedLine[];
}

export interface FoundOrder {
  externalOrderId: string;
  externalNumber: string | null;
}

export interface SupplierOrderStatusResult {
  statusRaw: string;
  /** null — сирий статус невідомий: нормалізований не змінюється (BR-SCON-012). */
  status: SupplierOrderStatus | null;
  externalNumber?: string | null;
  lines?: ConfirmedLine[];
}

export interface SupplierAdapter {
  readonly provider: SupplierProvider;
  readonly name: string;
  readonly capabilities: SupplierCapabilities;
  readonly credentialFields: SupplierFieldSpec[];
  readonly optionFields: SupplierFieldSpec[];
  /** Поля параметрів доставки на КОЖЕН наш склад (`options.warehouses[<id>]`). */
  readonly warehouseFields: SupplierFieldSpec[];

  /** Перевірка кредів без побічних ефектів (BR-SCON-004). */
  verify(conn: SupplierConnectionContext): Promise<void>;
  /** Онлайн-пошук. Для `search: 'mirror'` не викликається — шукає дзеркало. */
  search(conn: SupplierConnectionContext, query: SupplierSearchQuery): Promise<NormalizedOffer[]>;
  syncCatalog?(conn: SupplierConnectionContext, sink: CatalogSink): Promise<{ count: number }>;
  placeOrder(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    run: PlaceOrderRunner,
  ): Promise<PlacedOrderResult>;
  /** Звірка після неоднозначної відмови: чи є в постачальника замовлення з нашим reference. */
  findOrderByReference(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<FoundOrder | null>;
  getOrderStatus(
    conn: SupplierConnectionContext,
    order: SupplierOrderInput,
    state: SupplierOrderState,
  ): Promise<SupplierOrderStatusResult>;
}

/** DI-токен масиву адаптерів (як DELIVERY_PROVIDERS). */
export const SUPPLIER_ADAPTERS = Symbol('SUPPLIER_ADAPTERS');
