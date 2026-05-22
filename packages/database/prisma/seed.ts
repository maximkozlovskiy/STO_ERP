import { PrismaClient, VatMode, ZoneType, LiftType, WarehouseType, DocumentType, ResetPeriod, NotificationEventType, NotificationChannel, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const ORG_ID      = '00000000-0000-0000-0000-000000000001';
const BRANCH_ID   = '00000000-0000-0000-0000-000000000002';
const EMPLOYEE_ID = '00000000-0000-0000-0000-000000000010';

async function main() {
  console.warn('Seed: початок...');

  // ─── Organisation ────────────────────────────────────────
  const org = await prisma.organisation.upsert({
    where:  { id: ORG_ID },
    update: {},
    create: {
      id:    ORG_ID,
      orgId: ORG_ID,
      name:  'СТО Демо',
    },
  });
  console.warn(`  Org: ${org.name}`);

  // ─── GarageBranch ────────────────────────────────────────
  const branch = await prisma.garageBranch.upsert({
    where:  { id: BRANCH_ID },
    update: {},
    create: {
      id:      BRANCH_ID,
      orgId:   ORG_ID,
      name:    'Головна філія',
      address: 'вул. Автосервісна, 1, Київ',
    },
  });
  console.warn(`  Branch: ${branch.name}`);

  // ─── OrganisationSettings ────────────────────────────────
  await prisma.organisationSettings.upsert({
    where:  { orgId: ORG_ID },
    update: {},
    create: {
      orgId:                 ORG_ID,
      currency:              'UAH',
      vatMode:               VatMode.EXCLUSIVE,
      invoiceDueDays:        7,
      autoArchiveDays:       30,
      defaultWarrantyDays:   30,
      requireClientApproval: true,
      allowPartialPayment:   true,
    },
  });

  // ─── BranchSettings ──────────────────────────────────────
  await prisma.branchSettings.upsert({
    where:  { branchId: BRANCH_ID },
    update: {},
    create: {
      branchId:           BRANCH_ID,
      orgId:              ORG_ID,
      workStartTime:      '08:00',
      workEndTime:        '18:00',
      workDays:           [1, 2, 3, 4, 5, 6],
      slotDurationMinutes: 60,
    },
  });

  // ─── TaxRates ────────────────────────────────────────────
  const taxRatesData = [
    { name: 'ПДВ 20%',     rate: '20.00', isDefault: true  },
    { name: 'ПДВ 7%',      rate: '7.00',  isDefault: false },
    { name: 'Без ПДВ',     rate: '0.00',  isDefault: false },
  ];
  for (const t of taxRatesData) {
    await prisma.taxRate.upsert({
      where:  { orgId_rate: { orgId: ORG_ID, rate: t.rate } },
      update: {},
      create: { orgId: ORG_ID, ...t, isActive: true },
    });
  }
  console.warn('  TaxRates: 3 записи');

  // ─── PaymentMethodConfig ─────────────────────────────────
  const paymentMethods = [
    { code: 'cash',           name: 'Готівка',           sortOrder: 1, requiresFiscal: true  },
    { code: 'card_terminal',  name: 'Картка (термінал)', sortOrder: 2, requiresFiscal: true  },
    { code: 'bank_transfer',  name: 'Банківський переказ', sortOrder: 3, requiresFiscal: false },
    { code: 'privat24_qr',   name: 'PrivatBank QR',     sortOrder: 4, requiresFiscal: false },
    { code: 'monobank_qr',   name: 'Monobank QR',       sortOrder: 5, requiresFiscal: false },
  ];
  for (const pm of paymentMethods) {
    await prisma.paymentMethodConfig.upsert({
      where:  { orgId_code: { orgId: ORG_ID, code: pm.code } },
      update: {},
      create: { orgId: ORG_ID, isActive: true, ...pm },
    });
  }
  console.warn('  PaymentMethods: 5 записів');

  // ─── DocumentNumberConfig ────────────────────────────────
  const docConfigs: { documentType: DocumentType; prefix: string }[] = [
    { documentType: DocumentType.WORK_ORDER,      prefix: 'НРД' },
    { documentType: DocumentType.INVOICE,         prefix: 'РАХ' },
    { documentType: DocumentType.PURCHASE_ORDER,  prefix: 'ЗАМ' },
    { documentType: DocumentType.STOCK_RECEIPT,   prefix: 'ПРХ' },
    { documentType: DocumentType.STOCK_WRITEOFF,  prefix: 'СПС' },
    { documentType: DocumentType.STOCK_TRANSFER,  prefix: 'ПРМ' },
    { documentType: DocumentType.STOCK_OPENING,   prefix: 'ВЗЛ' },
    { documentType: DocumentType.RECONCILIATION_ACT, prefix: 'АКТ' },
  ];
  for (const dc of docConfigs) {
    await prisma.documentNumberConfig.upsert({
      where:  { orgId_documentType: { orgId: ORG_ID, documentType: dc.documentType } },
      update: {},
      create: {
        orgId:        ORG_ID,
        documentType: dc.documentType,
        prefix:       dc.prefix,
        includeDate:  true,
        dateFormat:   'YYYYMMDD',
        separator:    '-',
        padding:      6,
        currentSeq:   0,
        resetPeriod:  ResetPeriod.YEARLY,
      },
    });
  }
  console.warn('  DocumentNumberConfigs: 8 записів');

  // ─── NotificationTemplates ───────────────────────────────
  const templates = [
    {
      eventType: NotificationEventType.WO_COMPLETED,
      channel:   NotificationChannel.SMS,
      body:      'Вітаємо, {{clientName}}! Ваш автомобіль {{vehiclePlate}} готовий до видачі. {{branchName}}, тел: {{branchPhone}}',
    },
    {
      eventType: NotificationEventType.WO_ESTIMATE_READY,
      channel:   NotificationChannel.SMS,
      body:      '{{clientName}}, кошторис на ремонт {{vehiclePlate}} готовий. Сума: {{totalAmount}} ₴. Для підтвердження зателефонуйте нам.',
    },
    {
      eventType: NotificationEventType.PAYMENT_RECEIVED,
      channel:   NotificationChannel.SMS,
      body:      'Дякуємо! Оплата {{totalAmount}} ₴ по наряду {{woNumber}} отримана. {{branchName}}',
    },
  ];
  for (const t of templates) {
    await prisma.notificationTemplate.upsert({
      where:  { orgId_eventType_channel: { orgId: ORG_ID, eventType: t.eventType, channel: t.channel } },
      update: {},
      create: { orgId: ORG_ID, isActive: true, ...t },
    });
  }
  console.warn('  NotificationTemplates: 3 записи');

  // ─── Zones & Lifts ───────────────────────────────────────
  const ZONE_MECH_ID = '00000000-0000-0000-0000-000000000010';
  const ZONE_TIRE_ID = '00000000-0000-0000-0000-000000000011';
  await prisma.zone.upsert({
    where:  { id: ZONE_MECH_ID },
    update: {},
    create: { id: ZONE_MECH_ID, orgId: ORG_ID, branchId: BRANCH_ID, name: 'Механічна зона', type: ZoneType.MECHANICAL },
  });
  await prisma.zone.upsert({
    where:  { id: ZONE_TIRE_ID },
    update: {},
    create: { id: ZONE_TIRE_ID, orgId: ORG_ID, branchId: BRANCH_ID, name: 'Шиномонтаж', type: ZoneType.TIRE },
  });
  await prisma.lift.upsert({
    where:  { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000020', orgId: ORG_ID, zoneId: ZONE_MECH_ID, name: 'Підйомник №1', type: LiftType.TWO_POST, maxWeightKg: 3500 },
  });
  await prisma.lift.upsert({
    where:  { id: '00000000-0000-0000-0000-000000000021' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000021', orgId: ORG_ID, zoneId: ZONE_MECH_ID, name: 'Підйомник №2', type: LiftType.FOUR_POST, maxWeightKg: 5000 },
  });
  console.warn('  Zones: 2, Lifts: 2');

  // ─── Warehouse ───────────────────────────────────────────
  await prisma.warehouse.upsert({
    where:  { id: '00000000-0000-0000-0000-000000000030' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000030', orgId: ORG_ID, branchId: BRANCH_ID, name: 'Головний склад', type: WarehouseType.MAIN },
  });
  console.warn('  Warehouse: 1');

  // ─── WorkCategories ──────────────────────────────────────
  const CAT_ENGINE_ID = '00000000-0000-0000-0000-000000000040';
  const CAT_SUSP_ID   = '00000000-0000-0000-0000-000000000041';
  const CAT_TIRE_ID   = '00000000-0000-0000-0000-000000000042';
  await prisma.workCategory.upsert({
    where:  { id: CAT_ENGINE_ID },
    update: {},
    create: { id: CAT_ENGINE_ID, orgId: ORG_ID, name: 'Двигун та трансмісія', sortOrder: 1 },
  });
  await prisma.workCategory.upsert({
    where:  { id: CAT_SUSP_ID },
    update: {},
    create: { id: CAT_SUSP_ID, orgId: ORG_ID, name: 'Підвіска та кермо', sortOrder: 2 },
  });
  await prisma.workCategory.upsert({
    where:  { id: CAT_TIRE_ID },
    update: {},
    create: { id: CAT_TIRE_ID, orgId: ORG_ID, name: 'Шиномонтаж', sortOrder: 3 },
  });
  console.warn('  WorkCategories: 3');

  // ─── Default Admin Employee + AuthAccount ────────────────
  await prisma.employee.upsert({
    where:  { id: EMPLOYEE_ID },
    update: {},
    create: {
      id:         EMPLOYEE_ID,
      orgId:      ORG_ID,
      firstName:  'Адмін',
      lastName:   'СТО',
      role:       UserRole.OWNER,
      rateScheme: { type: 'fixed_plus_bonus', params: { fixed: 0, bonusPercent: 0 } },
    },
  });
  const adminPasswordHash = await bcrypt.hash('admin123', 12);
  await prisma.authAccount.upsert({
    where:  { employeeId: EMPLOYEE_ID },
    update: {},
    create: {
      orgId:        ORG_ID,
      employeeId:   EMPLOYEE_ID,
      email:        'admin@sto.local',
      passwordHash: adminPasswordHash,
    },
  });
  console.warn('  Admin: admin@sto.local / admin123');

  console.warn('Seed: завершено успішно.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
