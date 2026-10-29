import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayContains,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  isEmail,
  type ValidationOptions,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  PHONE_UA_REGEX,
  PNL_EXPENSE_CASH_REASON_OPTIONS,
  PNL_EXPENSE_CASH_REASON_REQUIRED,
  PNL_INCOME_CASH_REASON_OPTIONS,
} from '@sto/shared';
import {
  CashOperationReason,
  VatMode,
  BatchCostMethod,
  ShiftMode,
  SupplierAnalogPolicy,
  SupplierOrderSendMode,
  SupplierStrategy,
} from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { emptyToNull } from '../../common/transforms/empty-to-null';
import { toUpperCurrencyCode } from '../../common/transforms/to-upper-currency-code';

export interface UiFeatures {
  toastEnabled: boolean;
  unsavedGuardEnabled: boolean;
  stockIndicatorEnabled: boolean;
  commandPaletteEnabled: boolean;
  keyboardShortcutsEnabled: boolean;
  savedFiltersEnabled: boolean;
  inlineEditEnabled: boolean;
  syncIndicatorEnabled: boolean;
  notificationCenterEnabled: boolean;
  bulkActionsEnabled: boolean;
}

export const UI_FEATURES_DEFAULTS: UiFeatures = {
  toastEnabled: true,
  unsavedGuardEnabled: true,
  stockIndicatorEnabled: true,
  commandPaletteEnabled: true,
  keyboardShortcutsEnabled: true,
  savedFiltersEnabled: true,
  inlineEditEnabled: true,
  syncIndicatorEnabled: true,
  notificationCenterEnabled: true,
  bulkActionsEnabled: true,
};

export class UpdateOrganisationSettingsDto {
  // ISO 4217 валюта обліку — посилається на Currency.code (3-10 символів).
  // Bug review (currency feature): без поля у DTO `forbidNonWhitelisted: true`
  // глобально відхиляв PATCH з `currency` → save валюти у Settings → Org мовчки
  // фейлився 400-кою для користувача.
  // toUpperCurrencyCode нормалізує `uah` → `UAH` + trim + @MaxLength(10)
  // anti-DoS. Currency.code @db.VarChar(10) у схемі — поза 10 символів не пройде.
  @ApiPropertyOptional({ description: 'ISO код валюти обліку (UAH, USD, EUR)' })
  @IsOptional()
  @Transform(toUpperCurrencyCode)
  @IsString()
  @MaxLength(10, {
    message: 'err.dto.settings.currencyCode.max',
  })
  currency?: string;

  // emptyToUndefined gap — settings selects з default `''` → 400.
  @ApiPropertyOptional({ enum: VatMode })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(VatMode)
  vatMode?: VatMode;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  defaultVatRateId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  invoiceDueDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  autoArchiveDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  defaultWarrantyDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireClientApproval?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowPartialPayment?: boolean;

  @ApiPropertyOptional({ enum: ['blue', 'green', 'purple', 'orange', 'gray'] })
  @IsOptional()
  @IsString()
  brandTheme?: string;

  // Мова інтерфейсу org-дефолт. Bug #84: без поля у DTO forbidNonWhitelisted тихо дропне PATCH.
  @ApiPropertyOptional({ enum: ['uk', 'en'] })
  @IsOptional()
  @IsIn(['uk', 'en'])
  language?: string;

  // emptyToUndefined gap.
  @ApiPropertyOptional({ enum: BatchCostMethod })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(BatchCostMethod)
  costMethod?: BatchCostMethod;

  // B8: follow-up reminder settings. Bug #84 — Schema/DB had these fields, but
  // DTO/whitelist silently dropped them on PATCH and they never came back on GET.
  @ApiPropertyOptional({ description: 'Активувати follow-up нагадування' })
  @IsOptional()
  @IsBoolean()
  followUpActive?: boolean;

  @ApiPropertyOptional({
    minimum: 30,
    maximum: 365,
    description: 'Поріг днів без візиту',
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(365)
  followUpDays?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 90,
    description: 'Горизонт прогнозу нагадувань про ТО (днів наперед)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  maintenanceForecastDays?: number;

  @ApiPropertyOptional({
    description: 'Година автозавантаження курсів НБУ (0–23)',
    minimum: 0,
    maximum: 23,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  nbuFetchHour?: number;

  @ApiPropertyOptional({
    description: 'Інтервал опитування служби доставки (хв). clamp [5,1440].',
    minimum: 5,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  deliveryPollIntervalMinutes?: number;

  @ApiPropertyOptional({
    description: 'Інтервал auto-pull банк-виписки Privat24 (хв). clamp [15,1440].',
    minimum: 15,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  bankStatementPollIntervalMinutes?: number;

  @ApiPropertyOptional({ description: 'Скільки днів зберігати логи інтеграцій (1–365)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  integrationLogRetentionDays?: number;

  @ApiPropertyOptional({
    description: 'Частка ФОП механіків у виручці з робіт (звіт рентабельності). clamp [0,1].',
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  laborCostRatio?: number;

  // ── Звіт P&L (BR-RPT-030, рішення власника 2026-10-29): які приводи каси рахувати ──
  @ApiPropertyOptional({
    enum: PNL_INCOME_CASH_REASON_OPTIONS,
    isArray: true,
    description: 'P&L: приводи касових надходжень зі статтею типу INCOME, що є «іншим доходом»',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PNL_INCOME_CASH_REASON_OPTIONS.length)
  @ArrayUnique()
  @IsIn(PNL_INCOME_CASH_REASON_OPTIONS, { each: true })
  pnlIncomeCashReasons?: CashOperationReason[];

  @ApiPropertyOptional({
    enum: PNL_EXPENSE_CASH_REASON_OPTIONS,
    isArray: true,
    description:
      'P&L: приводи касових видач зі статтею типу EXPENSE, що є витратою (EXPENSE — завжди)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PNL_EXPENSE_CASH_REASON_OPTIONS.length)
  @ArrayUnique()
  @IsIn(PNL_EXPENSE_CASH_REASON_OPTIONS, { each: true })
  @ArrayContains([PNL_EXPENSE_CASH_REASON_REQUIRED], {
    message: 'err.dto.settings.pnlExpenseRequired',
  })
  pnlExpenseCashReasons?: CashOperationReason[];

  @ApiPropertyOptional({
    description: 'P&L: попереджати «зарплату не розраховано» і про місяці, що ще не почалися',
  })
  @IsOptional()
  @IsBoolean()
  pnlWarnFuturePayroll?: boolean;

  @ApiPropertyOptional({
    description:
      'P&L: повернення підзвітних коштів зменшує витрату статті (діє, коли «Під звіт» серед витрат)',
  })
  @IsOptional()
  @IsBoolean()
  pnlNetAdvanceReturns?: boolean;

  @ApiPropertyOptional({ description: 'UI feature flags (partial update supported)' })
  @IsOptional()
  @IsObject()
  uiFeatures?: Partial<UiFeatures>;

  // B4: Loyalty program
  @ApiPropertyOptional({ description: 'Увімкнути програму лояльності' })
  @IsOptional()
  @IsBoolean()
  loyaltyEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Нараховувати бали за кожні N грн',
    minimum: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  loyaltyEarnPer?: number;

  @ApiPropertyOptional({ description: 'Кількість балів за N грн', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyEarnPoints?: number;

  @ApiPropertyOptional({ description: '1 бал = N грн знижки', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyRedeemRate?: number;

  @ApiPropertyOptional({
    description: 'Перераховувати планові нормогодини по сумі рядків робіт',
  })
  @IsOptional()
  @IsBoolean()
  recalcPlannedHoursFromLines?: boolean;

  @ApiPropertyOptional({
    description: 'Перераховувати фактичні нормогодини по сумі рядків робіт',
  })
  @IsOptional()
  @IsBoolean()
  recalcActualHoursFromLines?: boolean;

  // ── Закупівля через API постачальників (BR-SCON-009, BR-SOFR-005…008; межі — CHECK міграції) ──
  @ApiPropertyOptional({
    enum: SupplierOrderSendMode,
    description: 'Передача замовлення в API: кнопкою чи при «Замовлено»',
  })
  @IsOptional()
  @IsEnum(SupplierOrderSendMode)
  supplierOrderSendMode?: SupplierOrderSendMode;

  @ApiPropertyOptional({
    enum: SupplierAnalogPolicy,
    description: 'Аналог поза каталогом (лише ручні позиції)',
  })
  @IsOptional()
  @IsEnum(SupplierAnalogPolicy)
  supplierAnalogPolicy?: SupplierAnalogPolicy;

  @ApiPropertyOptional({
    enum: SupplierStrategy,
    description: 'Стратегія автопідбору за замовчуванням',
  })
  @IsOptional()
  @IsEnum(SupplierStrategy)
  supplierDefaultStrategy?: SupplierStrategy;

  @ApiPropertyOptional({
    description: '«Оптимально»: вага ціни [0,1], вага терміну 1 − w',
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1)
  supplierOptimalPriceWeight?: number;

  @ApiPropertyOptional({ description: 'Автопідбір ділить позицію між різними постачальниками' })
  @IsOptional()
  @IsBoolean()
  supplierAllowSplit?: boolean;

  @ApiPropertyOptional({ description: 'Аналоги в автопідборі' })
  @IsOptional()
  @IsBoolean()
  supplierAllowAnalogsInAuto?: boolean;

  @ApiPropertyOptional({
    description: 'Пропозиція застаріла після (хв)',
    minimum: 5,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  supplierOfferTtlMinutes?: number;

  @ApiPropertyOptional({
    description: 'Скільки днів зберігати пропозиції',
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  supplierOfferRetentionDays?: number;

  @ApiPropertyOptional({
    description: 'Інтервал опитування статусу замовлень (хв)',
    minimum: 5,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  supplierOrderPollIntervalMinutes?: number;

  @ApiPropertyOptional({
    description: 'Інтервал синхронізації дзеркала каталогу (хв)',
    minimum: 60,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(1440)
  supplierCatalogSyncIntervalMinutes?: number;

  @ApiPropertyOptional({
    description: 'Термін для пропозиції без даних про доставку (дні)',
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  supplierUnknownDeliveryDays?: number;
}

// HH:MM regex (00:00–23:59). Без regex backend приймає 'foo'/'25:99' →
// БД корумпована → getBranchSettings повертає сміття → frontend settings form
// показує невалідні значення; gorshe — workStartTime='20:00' + workEndTime='09:00'
// проходить (обидва валідні строки) → getWorkHours повертає інвертовані години →
// frontend dynHours=[] → NaN у CSS → DOM crash.
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateBranchSettingsDto {
  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @IsString()
  @Matches(HH_MM_RE, { message: 'err.dto.settings.time.format' })
  workStartTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  @Matches(HH_MM_RE, { message: 'err.dto.settings.time.format' })
  workEndTime?: string;

  @ApiPropertyOptional({ minimum: 15, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  slotDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fiscalEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxApiUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxLicenseKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxPinCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxCashRegisterId?: string;

  @ApiPropertyOptional({ enum: ShiftMode })
  @IsOptional()
  @IsEnum(ShiftMode)
  shiftMode?: ShiftMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  monobankToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  monobankApiUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsApiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsSenderName?: string;

  @ApiPropertyOptional({
    description: 'Робочі дні тижня (0=нд, 1=пн, ..., 6=сб)',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  // Робочих днів максимум 7 (0-6); anti-DoS cap проти мільйон-дублікатних payload.
  @ArrayMaxSize(7, { message: 'err.dto.settings.workingDays.max' })
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workDays?: number[];
}

/** Базова валюта організації — єдине, що з налаштувань потрібне кожній ролі (Bug #847). */
export class BaseCurrencyResponseDto {
  @ApiProperty({ example: 'UAH', description: 'Код базової валюти організації' })
  currency!: string;
}

export class BrandingResponseDto {
  @ApiProperty({ example: 'green', description: 'Кольорова палітра інтерфейсу організації' })
  brandTheme!: string;
}

/**
 * Налаштування організації, які читає картка наряду (рішення власника 2026-10-16, employee.md):
 * механік отримує лише їх — без частки ФОП механіків (`laborCostRatio`), лояльності, методу
 * собівартості й інтервалів інтеграцій.
 */
export class OrganisationCardSettingsDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: VatMode }) vatMode!: VatMode;
  @ApiPropertyOptional() defaultVatRateId?: string | null;
  @ApiProperty() language!: string;
  @ApiProperty() recalcPlannedHoursFromLines!: boolean;
  @ApiProperty() recalcActualHoursFromLines!: boolean;
}

export class OrganisationSettingsResponseDto {
  @ApiProperty() orgId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: VatMode }) vatMode!: VatMode;
  @ApiPropertyOptional() defaultVatRateId?: string | null;
  @ApiProperty() invoiceDueDays!: number;
  @ApiProperty() autoArchiveDays!: number;
  @ApiProperty() defaultWarrantyDays!: number;
  @ApiProperty() requireClientApproval!: boolean;
  @ApiProperty() allowPartialPayment!: boolean;
  @ApiProperty() brandTheme!: string;
  @ApiProperty() language!: string;
  @ApiProperty({ enum: BatchCostMethod }) costMethod!: BatchCostMethod;
  @ApiProperty() followUpActive!: boolean;
  @ApiProperty() followUpDays!: number;
  @ApiProperty() maintenanceForecastDays!: number;
  @ApiProperty({
    description: 'Година автозавантаження курсів НБУ (0–23)',
  })
  nbuFetchHour!: number;
  @ApiProperty({ description: 'Інтервал опитування служби доставки (хв)' })
  deliveryPollIntervalMinutes!: number;
  @ApiProperty({ description: 'Інтервал auto-pull банк-виписки Privat24 (хв)' })
  bankStatementPollIntervalMinutes!: number;
  @ApiProperty({ description: 'Скільки днів зберігати логи інтеграцій' })
  integrationLogRetentionDays!: number;
  @ApiProperty({ description: 'Частка ФОП механіків у виручці з робіт (звіт рентабельності)' })
  laborCostRatio!: number;
  @ApiProperty({
    enum: PNL_INCOME_CASH_REASON_OPTIONS,
    isArray: true,
    description: 'P&L: приводи касових надходжень, що є «іншим доходом» (BR-RPT-030)',
  })
  pnlIncomeCashReasons!: CashOperationReason[];
  @ApiProperty({
    enum: PNL_EXPENSE_CASH_REASON_OPTIONS,
    isArray: true,
    description: 'P&L: приводи касових видач, що є витратою (BR-RPT-030)',
  })
  pnlExpenseCashReasons!: CashOperationReason[];
  @ApiProperty({ description: 'P&L: попереджати про нерозраховану зарплату майбутніх місяців' })
  pnlWarnFuturePayroll!: boolean;
  @ApiProperty({ description: 'P&L: повернення підзвіту зменшує витрату статті' })
  pnlNetAdvanceReturns!: boolean;
  @ApiProperty({ description: 'UI feature flags' }) uiFeatures!: UiFeatures;
  // B4: Loyalty
  @ApiProperty() loyaltyEnabled!: boolean;
  @ApiProperty() loyaltyEarnPer!: number;
  @ApiProperty() loyaltyEarnPoints!: number;
  @ApiProperty() loyaltyRedeemRate!: number;
  @ApiProperty({
    description: 'Перераховувати планові нормогодини по сумі рядків робіт',
  })
  recalcPlannedHoursFromLines!: boolean;
  @ApiProperty({
    description: 'Перераховувати фактичні нормогодини по сумі рядків робіт',
  })
  recalcActualHoursFromLines!: boolean;
  @ApiProperty({ enum: SupplierOrderSendMode }) supplierOrderSendMode!: SupplierOrderSendMode;
  @ApiProperty({ enum: SupplierAnalogPolicy }) supplierAnalogPolicy!: SupplierAnalogPolicy;
  @ApiProperty({ enum: SupplierStrategy }) supplierDefaultStrategy!: SupplierStrategy;
  @ApiProperty() supplierOptimalPriceWeight!: number;
  @ApiProperty() supplierAllowSplit!: boolean;
  @ApiProperty() supplierAllowAnalogsInAuto!: boolean;
  @ApiProperty() supplierOfferTtlMinutes!: number;
  @ApiProperty() supplierOfferRetentionDays!: number;
  @ApiProperty() supplierOrderPollIntervalMinutes!: number;
  @ApiProperty() supplierCatalogSyncIntervalMinutes!: number;
  @ApiProperty() supplierUnknownDeliveryDays!: number;
  @ApiProperty() updatedAt!: string;
}

export class BranchSettingsResponseDto {
  @ApiProperty() branchId!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workStartTime!: string;
  @ApiProperty() workEndTime!: string;
  @ApiProperty() workDays!: number[];
  @ApiProperty() slotDurationMinutes!: number;
  @ApiProperty() fiscalEnabled!: boolean;
  @ApiPropertyOptional() checkboxApiUrl?: string | null;
  @ApiPropertyOptional() checkboxCashRegisterId?: string | null;
  @ApiPropertyOptional() shiftMode?: string;
  @ApiPropertyOptional() monobankApiUrl?: string | null;
  @ApiPropertyOptional() hasMonobankToken?: boolean; // токен write-only — лише прапорець наявності
  @ApiProperty() smsEnabled!: boolean;
  @ApiPropertyOptional() smsProvider?: string | null;
  @ApiPropertyOptional() smsSenderName?: string | null;
  @ApiProperty() updatedAt!: string;
}

export class WorkHoursDto {
  @ApiProperty({ example: 8, description: 'Година початку роботи (0-23)' })
  workStartHour!: number;
  @ApiProperty({ example: 18, description: 'Година кінця роботи (0-23)' })
  workEndHour!: number;
}

/** ІПН платника ПДВ: 10 цифр (фізична особа) або 12 цифр (юридична). */
export const ORG_IPN_REGEX = /^(\d{10}|\d{12})$/;

// Власні назви обмежень, а не `matches` / `isEmail`: для тих validationExceptionFactory підставляє
// загальний шаблон («Поле "phone" має некоректний формат») і власне повідомлення не доходить.
const orgFormat = (name: string, test: (v: string) => boolean, message: string) =>
  ValidateBy({ name, validator: { validate: (v: unknown) => typeof v === 'string' && test(v) } }, {
    message,
  } satisfies ValidationOptions);

export class UpdateOrganisationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  edrpou?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.logoUrl !== null)
  @IsString()
  logoUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.legalAddress !== null)
  @IsString()
  legalAddress?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.actualAddress !== null)
  @IsString()
  actualAddress?: string | null;

  // Реквізити для шапки друкованих документів. Порожній рядок очищає поле (null).
  @ApiPropertyOptional({ example: '+380501234567', nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((o: UpdateOrganisationDto) => o.phone !== null)
  @orgFormat('orgPhone', v => PHONE_UA_REGEX.test(v), 'err.dto.organisation.phone.format')
  phone?: string | null;

  @ApiPropertyOptional({ example: 'info@sto.ua', nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((o: UpdateOrganisationDto) => o.email !== null)
  @orgFormat('orgEmail', v => isEmail(v), 'err.dto.organisation.email.invalid')
  email?: string | null;

  @ApiPropertyOptional({ example: '123456789012', nullable: true, description: 'ІПН платника ПДВ' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((o: UpdateOrganisationDto) => o.ipn !== null)
  @orgFormat('orgIpn', v => ORG_IPN_REGEX.test(v), 'err.dto.organisation.ipn.format')
  ipn?: string | null;

  /** Основний банківський рахунок — друкується в рахунках і нарядах. Чужий / видалений → 404. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @ValidateIf(o => o.bankAccountId !== null)
  @IsUUID()
  bankAccountId?: string | null;
}

export class OrganisationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() edrpou?: string | null;
  @ApiPropertyOptional() logoUrl?: string | null;
  @ApiPropertyOptional() legalAddress?: string | null;
  @ApiPropertyOptional() actualAddress?: string | null;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiPropertyOptional() ipn?: string | null;
  @ApiPropertyOptional() bankAccountId?: string | null;
  @ApiProperty() updatedAt!: string;
}
