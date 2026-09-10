/**
 * Shared status/badge/transition constants for all domain entities.
 * Uses string literals (not Prisma enums) — safe for browser bundles.
 * Single source of truth: import from '@sto/shared' everywhere.
 */

export type BadgeVariant =
  'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info' | 'purple';

// ─── Work Orders ─────────────────────────────────────────────────────────────

export const WO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD: 'Призупинено',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставлено',
  PAID: 'Оплачено',
  ARCHIVED: 'Архів',
  CANCELLED: 'Скасовано',
};

export const WO_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  ESTIMATE: 'warning',
  APPROVED: 'default',
  IN_PROGRESS: 'default',
  ON_HOLD: 'warning',
  COMPLETED: 'success',
  INVOICED: 'default',
  PAID: 'success',
  ARCHIVED: 'secondary',
  CANCELLED: 'destructive',
};

export const WO_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — наряд створено, ще не передано клієнту для погодження',
  ESTIMATE: 'Кошторис — підготовлено перелік робіт і запчастин, очікує затвердження',
  APPROVED: 'Затверджено — клієнт погодив, готово до початку робіт',
  IN_PROGRESS: 'В роботі — механік виконує ремонт',
  ON_HOLD: 'Призупинено — роботи тимчасово зупинені (очікування запчастин тощо)',
  COMPLETED: 'Виконано — всі роботи завершено, можна виставляти рахунок',
  INVOICED: 'Виставлено — рахунок передано клієнту, очікується оплата',
  PAID: 'Оплачено — клієнт оплатив, можна архівувати',
  ARCHIVED: 'Архів — закрито і перенесено в архів',
  CANCELLED: 'Скасовано — наряд скасовано',
};

// A5: ЄДИНЕ ДЖЕРЕЛО gate-множин для backend і frontend. Backend (work-orders.fsm.ts) ІМПОРТУЄ їх
// звідси (звужуючи до WorkOrderStatus[]), frontend читає напряму — жодного ручного дзеркалення.
// (Раніше backend мав власні копії з коментарем «Mirrors …» — drift-ризик усунено.)
export const WO_EDITABLE_STATUSES: readonly string[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);
export const WO_SHAREABLE_STATUSES: readonly string[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);
export const WO_INVOICEABLE_STATUSES: readonly string[] = Object.freeze(['COMPLETED', 'INVOICED']);
// Statuses where the Invoice slot should be VISIBLE in the work-order card.
// Superset of WO_INVOICEABLE_STATUSES: PAID and ARCHIVED work orders already have an
// invoice and it should remain accessible (view / download PDF) even after the WO is closed.
export const WO_INVOICE_VISIBLE_STATUSES: readonly string[] = Object.freeze([
  'COMPLETED',
  'INVOICED',
  'PAID',
  'ARCHIVED',
]);

// Single source of truth: must mirror backend `WORK_ORDER_TRANSITIONS`
// in apps/api/src/modules/work-orders/work-orders.fsm.ts. Backend is authoritative —
// if these diverge the UI offers transitions the API will reject with 400.
export const WO_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  // COMPLETED→CANCELLED (C2): скасування завершеного наряду повертає списані запчастини
  // на склад і сторнує борг (backend WorkOrdersService.returnPartsAndCredit). INVOICED/PAID
  // лишаються незворотними. Мусить збігатися з backend WORK_ORDER_TRANSITIONS.COMPLETED.
  COMPLETED: ['INVOICED', 'CANCELLED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

export const WO_PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Низький',
  NORMAL: 'Звичайний',
  HIGH: 'Високий',
  URGENT: 'Терміново',
};

export const WO_PRIORITY_BADGE: Record<string, BadgeVariant> = {
  LOW: 'secondary',
  NORMAL: 'default',
  HIGH: 'warning',
  URGENT: 'destructive',
};

export const WO_PRIORITY_DESCRIPTIONS: Record<string, string> = {
  LOW: 'Низький пріоритет — виконати за наявності вільного часу',
  NORMAL: 'Звичайний пріоритет — стандартна черга',
  HIGH: 'Високий пріоритет — виконати раніше стандартної черги',
  URGENT: 'Терміново — виконати якнайшвидше, клієнт чекає',
};

export const WO_CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE: 'ТО',
  CURRENT_REPAIR: 'Поточний ремонт',
  MAJOR_REPAIR: 'Кап. ремонт',
  BODY_REPAIR: 'Кузовний',
  DIAGNOSTICS: 'Діагностика',
  WARRANTY: 'Гарантійний',
  SEASONAL: 'Сезонне',
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  SENT: 'Надіслано',
  PARTIALLY_PAID: 'Частково оплачено',
  PAID: 'Оплачено',
  OVERDUE: 'Прострочено',
  CANCELLED: 'Скасовано',
};

export const INVOICE_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  SENT: 'default',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  OVERDUE: 'warning',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `INV_TRANSITIONS` in
// apps/api/src/modules/invoices/invoices.service.ts.
export const INVOICE_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — рахунок створено, ще не надіслано клієнту',
  SENT: 'Надіслано — рахунок передано клієнту, очікується оплата',
  PARTIALLY_PAID: 'Частково оплачено — отримано частину суми, є залишок',
  PAID: 'Оплачено — кошти отримано, розрахунок закрито',
  OVERDUE: 'Прострочено — термін оплати минув, потрібне нагадування',
  CANCELLED: 'Скасовано — рахунок анульовано',
};

export const INVOICE_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PAID', 'CANCELLED'],
  // PARTIALLY_PAID виставляється автоматично частковим платежем; вручну — дозакрити/скасувати.
  PARTIALLY_PAID: ['PAID', 'CANCELLED'],
  OVERDUE: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export const INVOICE_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Стандартний',
  PREPAYMENT: 'Аванс',
  CREDIT_NOTE: 'Кредит-нота',
};

// ─── Purchase Orders ──────────────────────────────────────────────────────────

export const PO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ORDERED: 'Замовлено',
  PARTIAL: 'Частково',
  RECEIVED: 'Отримано',
  CANCELLED: 'Скасовано',
};

export const PO_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  ORDERED: 'default',
  PARTIAL: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `PO_TRANSITIONS` in
// apps/api/src/modules/purchase-orders/purchase-orders.service.ts.
export const PO_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIAL', 'RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

export const PO_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — замовлення складено, ще не відправлено постачальнику',
  ORDERED: 'Замовлено — заявку відправлено постачальнику, очікується доставка',
  PARTIAL: 'Частково — частину товарів отримано, решта в дорозі',
  RECEIVED: 'Отримано — всі товари прийнято на склад',
  CANCELLED: 'Скасовано — замовлення анульовано',
};

export const PO_STATUS_ACTION_LABELS: Record<string, string> = {
  ORDERED: 'Підтвердити замовлення',
  RECEIVED: 'Позначити отриманим',
  CANCELLED: 'Скасувати',
  PARTIAL: 'Часткове отримання',
};

// ─── Supplier Returns ─────────────────────────────────────────────────────────

export const SUPPLIER_RETURN_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  CONFIRMED: 'Підтверджено',
  CANCELLED: 'Скасовано',
};

export const SUPPLIER_RETURN_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — повернення оформлено, ще не підтверджено',
  CONFIRMED: 'Підтверджено — товари повернуто постачальнику, залишок скориговано',
  CANCELLED: 'Скасовано — повернення анульовано',
};

export const SUPPLIER_RETURN_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  CONFIRMED: 'success',
  CANCELLED: 'destructive',
};

// ─── Supplier Payments ────────────────────────────────────────────────────────

export const SUPPLIER_PAYMENT_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  CONFIRMED: 'Проведено',
  CANCELLED: 'Скасовано',
};

export const SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — оплату оформлено, ще не проведено',
  CONFIRMED: 'Проведено — борг перед постачальником зменшено на суму оплати',
  CANCELLED: 'Скасовано — оплату анульовано',
};

export const SUPPLIER_PAYMENT_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  CONFIRMED: 'success',
  CANCELLED: 'destructive',
};

export const PAYMENT_SOURCE_TYPE_LABELS: Record<string, string> = {
  BANK_ACCOUNT: 'Банк',
  CASH_REGISTER: 'Каса',
};

// Фіскальний статус чеку (ПРРО) на Payment. null = фіскалізація не застосовна (метод без
// requiresFiscal) — у UI показувати «—».
export const FISCAL_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'У черзі',
  DONE: 'Пробито',
  FAILED: 'Помилка',
  SKIPPED: 'Пропущено',
};

export const FISCAL_STATUS_BADGE: Record<string, BadgeVariant> = {
  QUEUED: 'secondary',
  DONE: 'success',
  FAILED: 'destructive',
  SKIPPED: 'secondary',
};

export const FISCAL_STATUS_DESCRIPTIONS: Record<string, string> = {
  QUEUED: 'У черзі — чек очікує пробиття (офлайн-повтори до 24 год)',
  DONE: 'Пробито — фіскальний чек створено',
  FAILED: 'Помилка — не вдалося пробити чек після всіх спроб; можна повторити',
  SKIPPED: 'Пропущено — фіскалізацію вимкнено на філії',
};

// ─── Stock Documents ──────────────────────────────────────────────────────────

export const STOCK_DOC_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  CONFIRMED: 'Підтверджено',
  CANCELLED: 'Скасовано',
};

export const STOCK_DOC_STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — документ створено, залишки ще не змінено',
  CONFIRMED: 'Підтверджено — документ проведено, залишки оновлено',
  CANCELLED: 'Скасовано — документ анульовано, залишки не змінено',
};

export const STOCK_DOC_TYPE_DESCRIPTIONS: Record<string, string> = {
  TRANSFER: 'Переміщення — передача товарів між складами',
  WRITEOFF: 'Списання — вилучення товарів з обліку (брак, втрата тощо)',
  RECEIPT: 'Оприбуткування — отримання товарів від постачальника',
  OPENING_BALANCE: 'Початкові залишки — введення залишків при старті обліку',
};

export const STOCK_DOC_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  CONFIRMED: 'success',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `DOC_TRANSITIONS` in
// apps/api/src/modules/stock-documents/stock-documents.service.ts.
export const STOCK_DOC_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export const STOCK_DOC_TYPE_LABELS: Record<string, string> = {
  TRANSFER: 'Переміщення',
  WRITEOFF: 'Списання',
  RECEIPT: 'Оприбуткування',
  OPENING_BALANCE: 'Поч. залишки',
};

/** StockMovementType — усі 6 значень руху (STOCK_DOC_TYPE_LABELS покриває лише 4 документні). */
export const STOCK_MOVEMENT_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Прихід',
  WRITEOFF: 'Списання',
  TRANSFER: 'Переміщення',
  RESERVATION: 'Резервування',
  RESERVATION_RELEASE: 'Зняття резерву',
  OPENING_BALANCE: 'Поч. залишки',
};

/** SettlementTransactionType — 8 типів транзакцій взаєморозрахунків. */
export const SETTLEMENT_TX_TYPE_LABELS: Record<string, string> = {
  CHARGE: 'Нарахування',
  PAYMENT: 'Оплата',
  PREPAYMENT: 'Передоплата',
  REFUND: 'Повернення',
  CREDIT_NOTE: 'Кредит-нота',
  SUPPLIER_CHARGE: 'Нарахування (постач.)',
  SUPPLIER_PAYMENT: 'Оплата постачальнику',
  SUPPLIER_REFUND: 'Повернення постачальнику',
};

/**
 * ЄДИНЕ джерело знаку впливу транзакції на баланс — ДЗЕРКАЛО бекового `BALANCE_SIGN`
 * (apps/api/src/modules/settlements/settlements.service.ts). +1 = баланс росте, −1 = падає.
 *
 * Frontend раніше тримав дубльовані локальні `Set(['CHARGE','SUPPLIER_PAYMENT','SUPPLIER_REFUND'])`
 * у SettlementsTabContent і counterparties/[id]/PageClient для знаку «+»/«−» у рядку транзакції.
 * Дублі дрейфували б мовчки при зміні бекового BALANCE_SIGN (жоден тест не ловив). Тепер обидва
 * екрани споживають `SETTLEMENT_BALANCE_UP_TYPES` звідси; shared invariant-тест звіряє повноту
 * (усі 8 типів) і кожен ±1 — зміна знаку без синхронного оновлення тесту одразу червона.
 *
 * ⚠️ Це знак для БАЛАНСУ (арифметика), НЕ колір: колір рядка йде за бізнес-семантикою
 * «charge-like = борг створено = destructive» (CHARGE + SUPPLIER_CHARGE), решта = success —
 * див. SETTLEMENT_TX_CHARGE_LIKE_TYPES нижче. Знак і колір НАВМИСНЕ розходяться для
 * постачальницьких типів (SUPPLIER_PAYMENT: +1 знак, але success колір).
 */
export const SETTLEMENT_BALANCE_SIGN: Record<string, 1 | -1> = {
  CHARGE: 1, // клієнт винен нам більше
  PAYMENT: -1,
  PREPAYMENT: -1,
  REFUND: -1,
  CREDIT_NOTE: -1,
  SUPPLIER_CHARGE: -1, // ми винні постачальнику (баланс постач.-акаунта падає)
  SUPPLIER_PAYMENT: 1, // наш борг постачальнику меншає
  SUPPLIER_REFUND: 1,
};

/** Похідне: типи, що ЗБІЛЬШУЮТЬ баланс (sign=+1) — знак «+» у рядку транзакції. */
export const SETTLEMENT_BALANCE_UP_TYPES: ReadonlySet<string> = new Set(
  Object.keys(SETTLEMENT_BALANCE_SIGN).filter(t => SETTLEMENT_BALANCE_SIGN[t] === 1),
);

/**
 * Типи «charge-like» (борг створено) → колір destructive; решта → success.
 * Це БІЗНЕС-семантика кольору, окрема від balance-sign (постачальницькі типи розходяться).
 */
export const SETTLEMENT_TX_CHARGE_LIKE_TYPES: ReadonlySet<string> = new Set([
  'CHARGE',
  'SUPPLIER_CHARGE',
]);

export const STOCK_DOC_TYPE_BADGE: Record<string, BadgeVariant> = {
  WRITEOFF: 'destructive',
  TRANSFER: 'default',
  OPENING_BALANCE: 'secondary',
  RECEIPT: 'success',
};

// ─── Employees ────────────────────────────────────────────────────────────────

export const EMPLOYEE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активний',
  ON_LEAVE: 'У відпустці',
  FIRED: 'Звільнений',
};

export const EMPLOYEE_STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  FIRED: 'secondary',
};

export const EMPLOYEE_STATUS_DESCRIPTIONS: Record<string, string> = {
  ACTIVE: 'Активний — співробітник працює, доступний для призначення на наряди',
  ON_LEAVE: 'У відпустці — тимчасово недоступний',
  FIRED: 'Звільнений — більше не є співробітником підприємства',
};

export const EMPLOYEE_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік',
  STOREKEEPER: 'Комірник',
  ACCOUNTANT: 'Бухгалтер',
  CLIENT: 'Клієнт',
  XLSX_MANAGER: 'Менеджер імпорту',
};

export const EMPLOYEE_ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: 'Власник — повний доступ до всіх функцій системи',
  ADMIN: 'Адміністратор — управління налаштуваннями, довідниками, персоналом',
  RECEPTIONIST: 'Приймальник — створення нарядів, робота з клієнтами та рахунками',
  MECHANIC: 'Механік — виконання робіт по нарядах, перегляд своїх задач',
  STOREKEEPER: 'Комірник — управління складом, прийом і списання товарів',
  ACCOUNTANT: 'Бухгалтер — фінансові звіти, рахунки, взаєморозрахунки',
  CLIENT: 'Клієнт — обмежений доступ для перегляду власних нарядів',
  XLSX_MANAGER: 'Менеджер імпорту — завантаження товарів і довідників через XLSX',
};

export const EMPLOYEE_ROLE_BADGE: Record<string, BadgeVariant> = {
  OWNER: 'destructive',
  ADMIN: 'default',
  RECEPTIONIST: 'secondary',
  MECHANIC: 'warning',
  STOREKEEPER: 'secondary',
  ACCOUNTANT: 'secondary',
  CLIENT: 'secondary',
  XLSX_MANAGER: 'secondary',
};

// ─── Counterparty ─────────────────────────────────────────────────────────────

export const COUNTERPARTY_TYPE_LABELS: Record<string, string> = {
  CLIENT: 'Клієнт',
  SUPPLIER: 'Постачальник',
  BOTH: 'Обидва',
};

export const COUNTERPARTY_TYPE_BADGE: Record<string, BadgeVariant> = {
  CLIENT: 'default',
  SUPPLIER: 'secondary',
  BOTH: 'warning',
};

export const COUNTERPARTY_TYPE_DESCRIPTIONS: Record<string, string> = {
  CLIENT: 'Клієнт — фізична або юридична особа, якій надаються послуги',
  SUPPLIER: 'Постачальник — організація або ФОП, у якої закуповуються товари',
  BOTH: 'Клієнт і постачальник одночасно',
};

export const CONTRACT_TYPE_LABELS: Record<string, string> = {
  PURCHASE: 'Купівля',
  SALE: 'Продаж',
};

// ─── Good ─────────────────────────────────────────────────────────────────────

export const GOOD_TYPE_LABELS: Record<string, string> = {
  SPARE_PART: 'Запчастина',
  CONSUMABLE: 'Витратний матеріал',
  MATERIAL: 'Матеріал',
  TOOL: 'Інструмент',
};

export const GOOD_TYPE_BADGE: Record<string, BadgeVariant> = {
  SPARE_PART: 'default',
  CONSUMABLE: 'secondary',
  MATERIAL: 'warning',
  TOOL: 'success',
};

export const GOOD_TYPE_DESCRIPTIONS: Record<string, string> = {
  SPARE_PART: 'Запчастина — замінюваний компонент автомобіля',
  CONSUMABLE: 'Витратний матеріал — масло, фільтри, антифриз тощо',
  MATERIAL: 'Матеріал — сировина для ремонтних робіт',
  TOOL: 'Інструмент — обладнання та засоби виробництва',
};

// ─── Lift ─────────────────────────────────────────────────────────────────────

export const LIFT_STATUS_DESCRIPTIONS: Record<string, string> = {
  ACTIVE: 'Активний — підйомник справний і доступний для використання',
  MAINTENANCE: 'ТО — підйомник проходить технічне обслуговування',
  BROKEN: 'Несправний — потребує ремонту, недоступний для використання',
  DECOMMISSIONED: 'Списаний — виведений з експлуатації',
};
