import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { DocumentType } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { runUnscoped, getLocale } from '../../common/tenant/tenant-context';
import { SetupInitDto, SetupInitResponseDto } from './setup.dto';
import { DOCUMENT_NUMBER_DEFAULTS, type DocumentNumberDefault } from './document-number-defaults';

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async isAlreadyInitialized(): Promise<boolean> {
    const count = await this.prisma.organisation.count();
    return count > 0;
  }

  async init(dto: SetupInitDto): Promise<SetupInitResponseDto> {
    if (await this.isAlreadyInitialized()) {
      throw new BadRequestException(translateError('err.setup.alreadyConfigured', getLocale()));
    }

    const passwordHash = await bcrypt.hash(dto.ownerPassword, 12);

    // A1: bootstrap-транзакція виконується ДО існування tenant-контексту (створюємо саму організацію).
    // Organisation exempt, а всі child-create мають explicit orgId — але обгортаємо весь bootstrap у
    // runUnscoped, щоб tenant-guard не спіткнувся на count()/будь-якому майбутньому child-create без orgId.
    // ВАЖЛИВО: await ВСЕРЕДИНІ runUnscoped — ALS-scope тримається лише поки виконується callback; повернути
    // lazy-PrismaPromise назовні = scope вже вийшов до реального запиту (див. tenant-context.ts).
    const result = await runUnscoped(
      async () =>
        await this.prisma.$transaction(
          async tx => {
            // TOCTOU guard: isAlreadyInitialized() у init()/controller — це count() ПОЗА
            // транзакцією. Два concurrent POST /setup/init (обидва в межах Throttle 3/хв)
            // могли пройти перевірку count=0 і кожен створити ПОВНУ організацію+власника —
            // бо кожна tx має власний org.id, тож @@unique([orgId,email]) на AuthAccount
            // НЕ ловить дубль (orgId різні). Наслідок: дві Organisation, два OWNER — зламаний
            // single-tenant first-run інваріант.
            //
            // Fix: xact-advisory-lock серіалізує bootstrap. Другий виклик блокується до
            // COMMIT першого, після чого re-check count() всередині tx бачить org=1 → 400.
            // Lock авто-звільняється в кінці tx. Локальний Postgres → offline-safe.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sto-erp:setup:init'))`;

            const already = await tx.organisation.count();
            if (already > 0) {
              throw new BadRequestException(
                translateError('err.setup.alreadyConfigured', getLocale()),
              );
            }

            const org = await tx.organisation.create({
              data: {
                name: dto.orgName,
                edrpou: dto.edrpou ?? null,
                orgId: '00000000-0000-0000-0000-000000000000', // temp
              },
            });

            // Self-reference: initial orgId is a temp placeholder, update to org.id after creation.
            await tx.organisation.update({
              where: { id: org.id },
              data: { orgId: org.id },
            });

            await tx.organisationSettings.create({
              data: { orgId: org.id },
            });

            // Мультивалюта (TD1): сідимо БАЗОВУ валюту org (UAH — дефолт OrganisationSettings.currency)
            // при ініціалізації. Без цього getBaseCurrency(orgId).id === null для свіжої org → документи
            // створювались би з currencyId=null (NULL≡base fallback). Тепер база завжди резолвиться →
            // currencyId на грошових рядках гарантовано NOT NULL (див. міграцію 20260914190000).
            await tx.currency.create({
              data: {
                orgId: org.id,
                code: 'UAH',
                name: 'Гривня',
                fullName: 'Українська гривня',
                symbol: '₴',
                isSystem: true,
              },
            });

            // Bug #794: усі типи з enum, не ручний перелік — див. document-number-defaults.ts.
            // createMany: один round-trip; конфіги не мають зв'язків → безпечно в bootstrap tx.
            await tx.documentNumberConfig.createMany({
              data: (
                Object.entries(DOCUMENT_NUMBER_DEFAULTS) as [DocumentType, DocumentNumberDefault][]
              ).map(([documentType, cfg]) => ({
                orgId: org.id,
                documentType,
                prefix: cfg.prefix,
                resetPeriod: cfg.resetPeriod,
                ...(cfg.includeDate === undefined ? {} : { includeDate: cfg.includeDate }),
              })),
            });

            const methods = [
              { code: 'cash', name: 'Готівка', sortOrder: 1, requiresFiscal: true },
              { code: 'card_terminal', name: 'Термінал', sortOrder: 2, requiresFiscal: true },
              {
                code: 'bank_transfer',
                name: 'Банківський переказ',
                sortOrder: 3,
                requiresFiscal: false,
              },
              { code: 'privat24_qr', name: 'PrivatPay QR', sortOrder: 4, requiresFiscal: true },
              { code: 'monobank_qr', name: 'MonoPay QR', sortOrder: 5, requiresFiscal: true },
              // Онлайн-оплата (еквайринг) через registry-шлюзи. payment-polling.processor створює
              // Payment із method=`${gateway}_qr` (monobank_qr / liqpay_qr) — код мусить існувати у
              // PaymentMethodConfig, інакше платіж НЕ фіскалізується й не мапиться на рахунок-призначення.
              { code: 'liqpay_qr', name: 'LiqPay QR', sortOrder: 6, requiresFiscal: true },
            ];
            await tx.paymentMethodConfig.createMany({
              data: methods.map(m => ({ orgId: org.id, ...m })),
            });

            await tx.taxRate.createMany({
              data: [
                { orgId: org.id, name: 'Без ПДВ', rate: 0, isDefault: false },
                { orgId: org.id, name: 'ПДВ 20%', rate: 20, isDefault: true },
                { orgId: org.id, name: 'ПДВ 7%', rate: 7, isDefault: false },
              ],
            });

            const branch = await tx.garageBranch.create({
              data: {
                orgId: org.id,
                name: dto.branchName,
                address: dto.branchAddress,
              },
            });

            await tx.branchSettings.create({
              data: { branchId: branch.id, orgId: org.id },
            });

            const warehouse = await tx.warehouse.create({
              data: {
                orgId: org.id,
                branchId: branch.id,
                name: dto.warehouseName ?? 'Основний склад',
                type: 'MAIN',
              },
            });

            const employee = await tx.employee.create({
              data: {
                orgId: org.id,
                firstName: dto.ownerFirstName,
                lastName: dto.ownerLastName,
                role: 'OWNER',
                rateScheme: { type: 'percent_normo', params: { percent: 40 } },
              },
            });

            await tx.authAccount.create({
              data: {
                orgId: org.id,
                employeeId: employee.id,
                email: dto.ownerEmail.toLowerCase(),
                passwordHash,
              },
            });

            return { org, branch, warehouse, employee };
          },
          { timeout: 15_000 },
        ),
    ); // bootstrap creates 14+ rows; default 5s може недостатньо на повільному disk

    const accessToken = this.authService.generateAccessToken({
      sub: result.employee.id,
      orgId: result.org.id,
      role: result.employee.role,
    });

    return {
      orgId: result.org.id,
      branchId: result.branch.id,
      warehouseId: result.warehouse.id,
      employeeId: result.employee.id,
      accessToken,
    };
  }
}
