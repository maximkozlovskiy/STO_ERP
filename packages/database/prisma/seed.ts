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
const BRANCH2_ID = 'a1000000-0000-4000-8000-000000000003';
const ZONE_MECH_ID = 'a1000000-0000-4000-8000-000000000011';
const ZONE_TIRE_ID = 'a1000000-0000-4000-8000-000000000012';
const LIFT1_ID = 'a1000000-0000-4000-8000-000000000020';
const LIFT2_ID = 'a1000000-0000-4000-8000-000000000021';
const WAREHOUSE_ID = 'a1000000-0000-4000-8000-000000000030';
const WAREHOUSE2_ID = 'a1000000-0000-4000-8000-000000000031';
const CAT_ENGINE_ID = 'a1000000-0000-4000-8000-000000000040';
const CAT_SUSP_ID = 'a1000000-0000-4000-8000-000000000041';
const CAT_TIRE_ID = 'a1000000-0000-4000-8000-000000000042';
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

  // ─── GarageBranch #2 (v4 UUID — for E2E WO tests) ───────
  await prisma.garageBranch.upsert({
    where: { id: BRANCH2_ID },
    update: {},
    create: {
      id: BRANCH2_ID,
      orgId: ORG_ID,
      name: 'Філія (тестова)',
      address: 'вул. Тестова, 2, Київ',
    },
  });
  await prisma.branchSettings.upsert({
    where: { branchId: BRANCH2_ID },
    update: {},
    create: {
      branchId: BRANCH2_ID,
      orgId: ORG_ID,
      workStartTime: '08:00',
      workEndTime: '18:00',
      workDays: [1, 2, 3, 4, 5, 6],
      slotDurationMinutes: 60,
    },
  });
  console.warn('  Branch2: Філія (тестова)');

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
  console.warn('  DocumentNumberConfigs: 8 записів');

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
      body: '{{clientName}}, кошторис на ремонт {{vehiclePlate}} готовий. Сума: {{totalAmount}} ₴. Для підтвердження зателефонуйте нам.',
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

  // ─── WorkCategories ──────────────────────────────────────
  await prisma.workCategory.upsert({
    where: { id: CAT_ENGINE_ID },
    update: {},
    create: { id: CAT_ENGINE_ID, orgId: ORG_ID, name: 'Двигун та трансмісія', sortOrder: 1 },
  });
  await prisma.workCategory.upsert({
    where: { id: CAT_SUSP_ID },
    update: {},
    create: { id: CAT_SUSP_ID, orgId: ORG_ID, name: 'Підвіска та кермо', sortOrder: 2 },
  });
  await prisma.workCategory.upsert({
    where: { id: CAT_TIRE_ID },
    update: {},
    create: { id: CAT_TIRE_ID, orgId: ORG_ID, name: 'Шиномонтаж', sortOrder: 3 },
  });
  console.warn('  WorkCategories: 3');

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
      rateScheme: { type: 'fixed_plus_bonus', params: { fixed: 0, bonusPercent: 0 } },
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
  await prisma.work.upsert({
    where: { id: WORK1_ID },
    update: {},
    create: {
      id: WORK1_ID,
      orgId: ORG_ID,
      categoryId: CAT_ENGINE_ID,
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
      categoryId: CAT_SUSP_ID,
      name: 'Заміна амортизатора',
      normoHours: 1.5,
      price: '800.00',
    },
  });
  console.warn('  Works: 2');

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

  console.warn('Seed: завершено успішно.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
