import {
  PrismaClient,
  VatMode,
  ZoneType,
  LiftType,
  WarehouseType,
  DocumentType,
  ResetPeriod,
  NotificationEventType,
  NotificationChannel,
  UserRole,
  CounterpartyType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// All UUIDs are v4-compatible (version nibble = 4, variant = 8/9/a/b)
// Nil-like UUIDs (00000000-...) fail @IsUUID() in class-validator — cannot be used in API calls
const ORG_ID = 'a1000000-0000-4000-8000-000000000001';
const BRANCH_ID = 'a1000000-0000-4000-8000-000000000002';
const EMPLOYEE_ID = 'a1000000-0000-4000-8000-000000000010';

// E2E seed constants
const ZONE_MECH_ID = 'a1000000-0000-4000-8000-000000000011';
const ZONE_TIRE_ID = 'a1000000-0000-4000-8000-000000000012';
const LIFT1_ID = 'a1000000-0000-4000-8000-000000000020';
const LIFT2_ID = 'a1000000-0000-4000-8000-000000000021';
const WAREHOUSE_ID = 'a1000000-0000-4000-8000-000000000030';
const WAREHOUSE2_ID = 'a1000000-0000-4000-8000-000000000031';
const SUPPLIER_ID = 'a1000000-0000-4000-8000-000000000050';
const CLIENT_ID = 'a1000000-0000-4000-8000-000000000051';
const GARAGE_ID = 'a1000000-0000-4000-8000-000000000052';
const VEHICLE_ID = 'a1000000-0000-4000-8000-000000000053';
const WORK1_ID = 'a1000000-0000-4000-8000-000000000060';
const WORK2_ID = 'a1000000-0000-4000-8000-000000000061';
const GOOD1_ID = 'a1000000-0000-4000-8000-000000000070';
const GOOD2_ID = 'a1000000-0000-4000-8000-000000000071';
const BRAND_BOSCH_ID = 'a1000000-0000-4000-8000-000000000080';

async function main() {
  console.warn('Seed: початок...');

  // ─── Organisation ────────────────────────────────────────
  const org = await prisma.organisation.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      orgId: ORG_ID,
      name: 'СТО Демо',
    },
  });
  console.warn(`  Org: ${org.name}`);

  // ─── GarageBranch ────────────────────────────────────────
  const branch = await prisma.garageBranch.upsert({
    where: { id: BRANCH_ID },
    update: {},
    create: {
      id: BRANCH_ID,
      orgId: ORG_ID,
      name: 'Головна філія',
      address: 'вул. Автосервісна, 1, Київ',
    },
  });
  console.warn(`  Branch: ${branch.name}`);

  // ─── OrganisationSettings ────────────────────────────────
  await prisma.organisationSettings.upsert({
    where: { orgId: ORG_ID },
    update: {},
    create: {
      orgId: ORG_ID,
      currency: 'UAH',
      vatMode: VatMode.EXCLUSIVE,
      invoiceDueDays: 7,
      autoArchiveDays: 30,
      defaultWarrantyDays: 30,
      requireClientApproval: false,
      allowPartialPayment: true,
    },
  });

  // ─── Default Currency (UAH) ──────────────────────────────
  await prisma.currency.upsert({
    where: { orgId_code: { orgId: ORG_ID, code: 'UAH' } },
    update: {},
    create: {
      orgId: ORG_ID,
      code: 'UAH',
      name: 'Гривня',
      fullName: 'Гривня',
      internationalName: 'Ukrainian Hryvnia',
      symbol: '₴',
    },
  });
  console.warn('  Currency: UAH (Гривня)');

  // ─── BranchSettings ──────────────────────────────────────
  await prisma.branchSettings.upsert({
    where: { branchId: BRANCH_ID },
    update: {},
    create: {
      branchId: BRANCH_ID,
      orgId: ORG_ID,
      workStartTime: '08:00',
      workEndTime: '18:00',
      workDays: [1, 2, 3, 4, 5, 6],
      slotDurationMinutes: 60,
    },
  });

  // ─── TaxRates ────────────────────────────────────────────
  const taxRatesData = [
    { name: 'ПДВ 20%', rate: '20.00', isDefault: true },
    { name: 'ПДВ 7%', rate: '7.00', isDefault: false },
    { name: 'Без ПДВ', rate: '0.00', isDefault: false },
  ];
  for (const t of taxRatesData) {
    await prisma.taxRate.upsert({
      where: { orgId_rate: { orgId: ORG_ID, rate: t.rate } },
      update: {},
      create: { orgId: ORG_ID, ...t, isActive: true },
    });
  }
  console.warn('  TaxRates: 3 записи');

  // ─── PaymentMethodConfig ─────────────────────────────────
  const paymentMethods = [
    { code: 'cash', name: 'Готівка', sortOrder: 1, requiresFiscal: true },
    { code: 'card_terminal', name: 'Картка (термінал)', sortOrder: 2, requiresFiscal: true },
    { code: 'bank_transfer', name: 'Банківський переказ', sortOrder: 3, requiresFiscal: false },
    { code: 'privat24_qr', name: 'PrivatBank QR', sortOrder: 4, requiresFiscal: false },
    { code: 'monobank_qr', name: 'Monobank QR', sortOrder: 5, requiresFiscal: false },
  ];
  for (const pm of paymentMethods) {
    await prisma.paymentMethodConfig.upsert({
      where: { orgId_code: { orgId: ORG_ID, code: pm.code } },
      update: {},
      create: { orgId: ORG_ID, isActive: true, ...pm },
    });
  }
  console.warn('  PaymentMethods: 5 записів');

  // ─── DocumentNumberConfig ────────────────────────────────
  const docConfigs: { documentType: DocumentType; prefix: string }[] = [
    { documentType: DocumentType.WORK_ORDER, prefix: 'НРД' },
    { documentType: DocumentType.INVOICE, prefix: 'РАХ' },
    { documentType: DocumentType.PURCHASE_ORDER, prefix: 'ЗАМ' },
    { documentType: DocumentType.STOCK_RECEIPT, prefix: 'ПРХ' },
    { documentType: DocumentType.STOCK_WRITEOFF, prefix: 'СПС' },
    { documentType: DocumentType.STOCK_TRANSFER, prefix: 'ПРМ' },
    { documentType: DocumentType.STOCK_OPENING, prefix: 'ВЗЛ' },
    { documentType: DocumentType.RECONCILIATION_ACT, prefix: 'АКТ' },
    { documentType: DocumentType.COUNTERPARTY_AGREEMENT, prefix: 'ДГ' },
  ];
  for (const dc of docConfigs) {
    await prisma.documentNumberConfig.upsert({
      where: { orgId_documentType: { orgId: ORG_ID, documentType: dc.documentType } },
      update: {},
      create: {
        orgId: ORG_ID,
        documentType: dc.documentType,
        prefix: dc.prefix,
        includeDate: true,
        dateFormat: 'YYYYMMDD',
        separator: '-',
        padding: 6,
        currentSeq: 0,
        resetPeriod: ResetPeriod.YEARLY,
      },
    });
  }
  console.warn('  DocumentNumberConfigs: 9 записів');

  // ─── NotificationTemplates ───────────────────────────────
  const templates = [
    {
      eventType: NotificationEventType.WO_COMPLETED,
      channel: NotificationChannel.SMS,
      body: 'Вітаємо, {{clientName}}! Ваш автомобіль {{vehiclePlate}} готовий до видачі. {{branchName}}, тел: {{branchPhone}}',
    },
    {
      eventType: NotificationEventType.WO_ESTIMATE_READY,
      channel: NotificationChannel.SMS,
      body: '{{clientName}}, кошторис на ремонт {{vehiclePlate}} готовий. Сума: {{totalAmount}} грн. Деталі: {{link}}',
    },
    {
      eventType: NotificationEventType.PAYMENT_RECEIVED,
      channel: NotificationChannel.SMS,
      body: 'Дякуємо! Оплата {{totalAmount}} ₴ по наряду {{woNumber}} отримана. {{branchName}}',
    },
    {
      eventType: NotificationEventType.FOLLOWUP_REMINDER,
      channel: NotificationChannel.SMS,
      body: 'Вітаємо, {{clientName}}! Запрошуємо на планове ТО для {{vehicleMake}} {{vehicleModel}} ({{licensePlate}}){{nextMaintenanceDate}}. Зателефонуйте нам для запису.',
    },
  ];
  for (const t of templates) {
    await prisma.notificationTemplate.upsert({
      where: {
        orgId_eventType_channel: { orgId: ORG_ID, eventType: t.eventType, channel: t.channel },
      },
      update: {},
      create: { orgId: ORG_ID, isActive: true, ...t },
    });
  }
  console.warn('  NotificationTemplates: 4 записи');

  // ─── Zones & Lifts ───────────────────────────────────────
  await prisma.zone.upsert({
    where: { id: ZONE_MECH_ID },
    update: {},
    create: {
      id: ZONE_MECH_ID,
      orgId: ORG_ID,
      branchId: BRANCH_ID,
      name: 'Механічна зона',
      type: ZoneType.MECHANICAL,
    },
  });
  await prisma.zone.upsert({
    where: { id: ZONE_TIRE_ID },
    update: {},
    create: {
      id: ZONE_TIRE_ID,
      orgId: ORG_ID,
      branchId: BRANCH_ID,
      name: 'Шиномонтаж',
      type: ZoneType.TIRE,
    },
  });
  await prisma.lift.upsert({
    where: { id: LIFT1_ID },
    update: {},
    create: {
      id: LIFT1_ID,
      orgId: ORG_ID,
      zoneId: ZONE_MECH_ID,
      name: 'Підйомник №1',
      type: LiftType.TWO_POST,
      maxWeightKg: 3500,
    },
  });
  await prisma.lift.upsert({
    where: { id: LIFT2_ID },
    update: {},
    create: {
      id: LIFT2_ID,
      orgId: ORG_ID,
      zoneId: ZONE_MECH_ID,
      name: 'Підйомник №2',
      type: LiftType.FOUR_POST,
      maxWeightKg: 5000,
    },
  });
  console.warn('  Zones: 2, Lifts: 2');

  // ─── Warehouse ───────────────────────────────────────────
  await prisma.warehouse.upsert({
    where: { id: WAREHOUSE_ID },
    update: {},
    create: {
      id: WAREHOUSE_ID,
      orgId: ORG_ID,
      branchId: BRANCH_ID,
      name: 'Головний склад',
      type: WarehouseType.MAIN,
    },
  });
  console.warn('  Warehouse: 1');

  // WorkCategories завантажуються через seed-catalog.ts (з JSON)

  // ─── Default Admin Employee + AuthAccount ────────────────
  await prisma.employee.upsert({
    where: { id: EMPLOYEE_ID },
    update: {},
    create: {
      id: EMPLOYEE_ID,
      orgId: ORG_ID,
      firstName: 'Адмін',
      lastName: 'СТО',
      role: UserRole.OWNER,
      // Bug #376: schema-key `fixedMonthly` (не `fixed`) — синхронно з rateSchemeSchema у employees.dto.ts
      rateScheme: { type: 'fixed_plus_bonus', params: { fixedMonthly: 0, bonusPercent: 0 } },
    },
  });
  const adminPasswordHash = await bcrypt.hash('admin123', 12);
  await prisma.authAccount.upsert({
    where: { employeeId: EMPLOYEE_ID },
    update: {},
    create: {
      orgId: ORG_ID,
      employeeId: EMPLOYEE_ID,
      email: 'admin@sto.local',
      passwordHash: adminPasswordHash,
    },
  });
  console.warn('  Admin: admin@sto.local / admin123');

  // ─── Second Warehouse (for TRANSFER E2E tests) ───────────
  await prisma.warehouse.upsert({
    where: { id: WAREHOUSE2_ID },
    update: {},
    create: {
      id: WAREHOUSE2_ID,
      orgId: ORG_ID,
      branchId: BRANCH_ID,
      name: 'Цех (майстерня)',
      type: WarehouseType.WORKSHOP,
    },
  });
  console.warn('  Warehouse2: Цех (майстерня)');

  // ─── Brand (Bosch) ───────────────────────────────────────
  const boschBrand = await prisma.brand.upsert({
    where: { orgId_name: { orgId: ORG_ID, name: 'Bosch' } },
    update: {},
    create: {
      id: BRAND_BOSCH_ID,
      orgId: ORG_ID,
      name: 'Bosch',
    },
  });
  const boschId = boschBrand.id;
  console.warn('  Brand: Bosch');

  // ─── Supplier (Counterparty type=SUPPLIER) ───────────────
  await prisma.counterparty.upsert({
    where: { id: SUPPLIER_ID },
    update: {},
    create: {
      id: SUPPLIER_ID,
      orgId: ORG_ID,
      type: CounterpartyType.SUPPLIER,
      firstName: 'Постачальник',
      lastName: 'Демо',
      companyName: 'АвтоДеталь ТОВ',
      phone: '+380671234567',
    },
  });
  // SettlementAccount для постачальника
  await prisma.settlementAccount.upsert({
    where: { counterpartyId: SUPPLIER_ID },
    update: {},
    create: {
      orgId: ORG_ID,
      counterpartyId: SUPPLIER_ID,
      balance: '0',
    },
  });
  console.warn('  Supplier: АвтоДеталь ТОВ');

  // ─── Client + Vehicle (for WO E2E tests) ─────────────────
  await prisma.counterparty.upsert({
    where: { id: CLIENT_ID },
    update: {},
    create: {
      id: CLIENT_ID,
      orgId: ORG_ID,
      type: CounterpartyType.CLIENT,
      firstName: 'Іван',
      lastName: 'Клієнт',
      phone: '+380671000001',
    },
  });
  await prisma.settlementAccount.upsert({
    where: { counterpartyId: CLIENT_ID },
    update: {},
    create: {
      orgId: ORG_ID,
      counterpartyId: CLIENT_ID,
      balance: '0',
    },
  });
  await prisma.customerGarage.upsert({
    where: { id: GARAGE_ID },
    update: {},
    create: {
      id: GARAGE_ID,
      orgId: ORG_ID,
      counterpartyId: CLIENT_ID,
      name: 'Основний',
      isDefault: true,
    },
  });
  await prisma.vehicle.upsert({
    where: { id: VEHICLE_ID },
    update: {},
    create: {
      id: VEHICLE_ID,
      orgId: ORG_ID,
      customerGarageId: GARAGE_ID,
      make: 'Toyota',
      model: 'Camry',
      year: 2020,
      licensePlate: 'AA1234BB',
    },
  });
  console.warn('  Client + Vehicle: Іван Клієнт / Toyota Camry');

  // ─── Works (for WO line E2E tests) ───────────────────────
  // Знаходимо системні категорії з JSON-каталогу по коду.
  // sto-optimize: послідовні findFirst об'єднано в Promise.all — 2 RTT → 1.
  const [catEngine, catSus] = await Promise.all([
    prisma.workCategory.findFirst({
      where: { orgId: ORG_ID, code: 'ENG', deletedAt: null },
      select: { id: true },
    }),
    prisma.workCategory.findFirst({
      where: { orgId: ORG_ID, code: 'SUS', deletedAt: null },
      select: { id: true },
    }),
  ]);
  if (catEngine && catSus) {
    await prisma.work.upsert({
      where: { id: WORK1_ID },
      update: {},
      create: {
        id: WORK1_ID,
        orgId: ORG_ID,
        categoryId: catEngine.id,
        name: 'Заміна моторного мастила',
        normoHours: 0.5,
        price: '350.00',
      },
    });
    await prisma.work.upsert({
      where: { id: WORK2_ID },
      update: {},
      create: {
        id: WORK2_ID,
        orgId: ORG_ID,
        categoryId: catSus.id,
        name: 'Заміна амортизатора',
        normoHours: 1.5,
        price: '800.00',
      },
    });
    console.warn('  Works: 2');
  } else {
    console.warn('  Works: пропущено (запусти seed-catalog.ts спочатку)');
  }

  // ─── Goods (for WO parts + PO lines E2E tests) ───────────
  await prisma.good.upsert({
    where: { id: GOOD1_ID },
    update: {},
    create: {
      id: GOOD1_ID,
      orgId: ORG_ID,
      name: 'Моторна олива 5W-40 (1л)',
      sku: 'OIL-5W40-1L',
      unit: 'шт',
      salePrice: '250.00',
      brandId: boschId,
    },
  });
  await prisma.good.upsert({
    where: { id: GOOD2_ID },
    update: {},
    create: {
      id: GOOD2_ID,
      orgId: ORG_ID,
      name: 'Фільтр масляний',
      sku: 'FILTER-OIL-001',
      unit: 'шт',
      salePrice: '180.00',
      brandId: boschId,
    },
  });
  console.warn('  Goods: 2');

  // ─── SystemTemplates ─────────────────────────────────────────────────────────
  const systemTemplates = [
    // Currencies
    {
      entityType: 'currency',
      key: 'UAH',
      name: 'Гривня',
      sortOrder: 1,
      data: {
        code: 'UAH',
        name: 'Гривня',
        symbol: '₴',
        fullName: 'Гривня',
        internationalName: 'Ukrainian Hryvnia',
      },
    },
    {
      entityType: 'currency',
      key: 'USD',
      name: 'Долар США',
      sortOrder: 2,
      data: {
        code: 'USD',
        name: 'Долар США',
        symbol: '$',
        fullName: 'Долар',
        internationalName: 'US Dollar',
      },
    },
    {
      entityType: 'currency',
      key: 'EUR',
      name: 'Євро',
      sortOrder: 3,
      data: { code: 'EUR', name: 'Євро', symbol: '€', fullName: 'Євро', internationalName: 'Euro' },
    },
    {
      entityType: 'currency',
      key: 'GBP',
      name: 'Фунт стерлінгів',
      sortOrder: 4,
      data: {
        code: 'GBP',
        name: 'Фунт стерлінгів',
        symbol: '£',
        fullName: 'Фунт',
        internationalName: 'Pound Sterling',
      },
    },
    {
      entityType: 'currency',
      key: 'PLN',
      name: 'Польський злотий',
      sortOrder: 5,
      data: {
        code: 'PLN',
        name: 'Польський злотий',
        symbol: 'zł',
        fullName: 'Злотий',
        internationalName: 'Polish Zloty',
      },
    },
    {
      entityType: 'currency',
      key: 'CZK',
      name: 'Чеська крона',
      sortOrder: 6,
      data: {
        code: 'CZK',
        name: 'Чеська крона',
        symbol: 'Kč',
        fullName: 'Крона',
        internationalName: 'Czech Koruna',
      },
    },
    {
      entityType: 'currency',
      key: 'CHF',
      name: 'Швейцарський франк',
      sortOrder: 7,
      data: {
        code: 'CHF',
        name: 'Швейцарський франк',
        symbol: 'Fr',
        fullName: 'Франк',
        internationalName: 'Swiss Franc',
      },
    },
    {
      entityType: 'currency',
      key: 'NOK',
      name: 'Норвезька крона',
      sortOrder: 8,
      data: {
        code: 'NOK',
        name: 'Норвезька крона',
        symbol: 'kr',
        fullName: 'Крона',
        internationalName: 'Norwegian Krone',
      },
    },
    {
      entityType: 'currency',
      key: 'SEK',
      name: 'Шведська крона',
      sortOrder: 9,
      data: {
        code: 'SEK',
        name: 'Шведська крона',
        symbol: 'kr',
        fullName: 'Крона',
        internationalName: 'Swedish Krona',
      },
    },
    {
      entityType: 'currency',
      key: 'DKK',
      name: 'Данська крона',
      sortOrder: 10,
      data: {
        code: 'DKK',
        name: 'Данська крона',
        symbol: 'kr',
        fullName: 'Крона',
        internationalName: 'Danish Krone',
      },
    },
    {
      entityType: 'currency',
      key: 'HUF',
      name: 'Угорський форинт',
      sortOrder: 11,
      data: {
        code: 'HUF',
        name: 'Угорський форинт',
        symbol: 'Ft',
        fullName: 'Форинт',
        internationalName: 'Hungarian Forint',
      },
    },
    {
      entityType: 'currency',
      key: 'RON',
      name: 'Румунський лей',
      sortOrder: 12,
      data: {
        code: 'RON',
        name: 'Румунський лей',
        symbol: 'lei',
        fullName: 'Лей',
        internationalName: 'Romanian Leu',
      },
    },
    {
      entityType: 'currency',
      key: 'BGN',
      name: 'Болгарський лев',
      sortOrder: 13,
      data: {
        code: 'BGN',
        name: 'Болгарський лев',
        symbol: 'лв',
        fullName: 'Лев',
        internationalName: 'Bulgarian Lev',
      },
    },
    {
      entityType: 'currency',
      key: 'TRY',
      name: 'Турецька ліра',
      sortOrder: 14,
      data: {
        code: 'TRY',
        name: 'Турецька ліра',
        symbol: '₺',
        fullName: 'Ліра',
        internationalName: 'Turkish Lira',
      },
    },
    {
      entityType: 'currency',
      key: 'CNY',
      name: 'Китайський юань',
      sortOrder: 15,
      data: {
        code: 'CNY',
        name: 'Китайський юань',
        symbol: '¥',
        fullName: 'Юань',
        internationalName: 'Chinese Yuan',
      },
    },

    // Units of measure
    {
      entityType: 'unit_of_measure',
      key: 'шт',
      name: 'штука',
      sortOrder: 1,
      data: { name: 'штука', shortName: 'шт', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'кг',
      name: 'кілограм',
      sortOrder: 2,
      data: { name: 'кілограм', shortName: 'кг', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'г',
      name: 'грам',
      sortOrder: 3,
      data: { name: 'грам', shortName: 'г', coefficient: 0.001 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'л',
      name: 'літр',
      sortOrder: 4,
      data: { name: 'літр', shortName: 'л', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'мл',
      name: 'мілілітр',
      sortOrder: 5,
      data: { name: 'мілілітр', shortName: 'мл', coefficient: 0.001 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'м',
      name: 'метр',
      sortOrder: 6,
      data: { name: 'метр', shortName: 'м', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'см',
      name: 'сантиметр',
      sortOrder: 7,
      data: { name: 'сантиметр', shortName: 'см', coefficient: 0.01 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'компл',
      name: 'комплект',
      sortOrder: 8,
      data: { name: 'комплект', shortName: 'компл', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'пара',
      name: 'пара',
      sortOrder: 9,
      data: { name: 'пара', shortName: 'пара', coefficient: 1 },
    },
    {
      entityType: 'unit_of_measure',
      key: 'год',
      name: 'година',
      sortOrder: 10,
      data: { name: 'година', shortName: 'год', coefficient: 1 },
    },

    // Payment methods
    {
      entityType: 'payment_method',
      key: 'cash',
      name: 'Готівка',
      sortOrder: 1,
      data: { code: 'cash', name: 'Готівка', sortOrder: 1, requiresFiscal: true, isActive: true },
    },
    {
      entityType: 'payment_method',
      key: 'card_terminal',
      name: 'Картка (термінал)',
      sortOrder: 2,
      data: {
        code: 'card_terminal',
        name: 'Картка (термінал)',
        sortOrder: 2,
        requiresFiscal: true,
        isActive: true,
      },
    },
    {
      entityType: 'payment_method',
      key: 'bank_transfer',
      name: 'Банківський переказ',
      sortOrder: 3,
      data: {
        code: 'bank_transfer',
        name: 'Банківський переказ',
        sortOrder: 3,
        requiresFiscal: false,
        isActive: true,
      },
    },
    {
      entityType: 'payment_method',
      key: 'privat24_qr',
      name: 'PrivatBank QR',
      sortOrder: 4,
      data: {
        code: 'privat24_qr',
        name: 'PrivatBank QR',
        sortOrder: 4,
        requiresFiscal: false,
        isActive: true,
      },
    },
    {
      entityType: 'payment_method',
      key: 'monobank_qr',
      name: 'Monobank QR',
      sortOrder: 5,
      data: {
        code: 'monobank_qr',
        name: 'Monobank QR',
        sortOrder: 5,
        requiresFiscal: false,
        isActive: true,
      },
    },

    // Work categories
    {
      entityType: 'work_category',
      key: 'MAINTENANCE',
      name: 'Технічне обслуговування',
      sortOrder: 1,
      data: { name: 'Технічне обслуговування', icon: 'wrench' },
    },
    {
      entityType: 'work_category',
      key: 'ENGINE',
      name: 'Ремонт двигуна та трансмісії',
      sortOrder: 2,
      data: { name: 'Ремонт двигуна та трансмісії', icon: 'cog' },
    },
    {
      entityType: 'work_category',
      key: 'BODY',
      name: 'Кузовні роботи',
      sortOrder: 3,
      data: { name: 'Кузовні роботи', icon: 'car' },
    },
    {
      entityType: 'work_category',
      key: 'ELECTRICAL',
      name: 'Електрика та електроніка',
      sortOrder: 4,
      data: { name: 'Електрика та електроніка', icon: 'zap' },
    },
    {
      entityType: 'work_category',
      key: 'TIRE',
      name: 'Шиномонтаж',
      sortOrder: 5,
      data: { name: 'Шиномонтаж', icon: 'circle' },
    },
    {
      entityType: 'work_category',
      key: 'DIAGNOSTICS',
      name: 'Діагностика',
      sortOrder: 6,
      data: { name: 'Діагностика', icon: 'search' },
    },
    {
      entityType: 'work_category',
      key: 'WASH',
      name: 'Мийка та хімчистка',
      sortOrder: 7,
      data: { name: 'Мийка та хімчистка', icon: 'droplet' },
    },
    {
      entityType: 'work_category',
      key: 'OIL_CHANGE',
      name: 'Заміна масла та фільтрів',
      sortOrder: 8,
      data: { name: 'Заміна масла та фільтрів', icon: 'refresh-cw' },
    },
  ];

  for (const t of systemTemplates) {
    await prisma.systemTemplate.upsert({
      where: { entityType_key: { entityType: t.entityType, key: t.key } },
      update: { name: t.name, data: t.data, sortOrder: t.sortOrder },
      create: t,
    });
  }
  console.warn(`  SystemTemplates: ${systemTemplates.length} шаблонів`);

  console.warn('Seed: завершено успішно.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
