import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
// ApiResponse is used for org-info endpoints above
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ResetPeriod } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import {
  BaseCurrencyResponseDto,
  BrandingResponseDto,
  BranchSettingsResponseDto,
  OrganisationCardSettingsDto,
  OrganisationResponseDto,
  OrganisationSettingsResponseDto,
  UiFeatures,
  UpdateBranchSettingsDto,
  UpdateOrganisationDto,
  UpdateOrganisationSettingsDto,
  WorkHoursDto,
} from './settings.dto';
import { SettingsService } from './settings.service';

class UpdateDocNumberDto {
  @ApiPropertyOptional() @IsOptional() @IsString() prefix?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeDate?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() separator?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(10) padding?: number;
  @ApiPropertyOptional({ enum: ResetPeriod })
  @IsOptional()
  @IsIn(Object.values(ResetPeriod))
  resetPeriod?: ResetPeriod;
}

class CreateTaxRateDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsNumber() @Min(0) @Max(100) rate!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateTaxRateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) rate?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * Ролі, яким `GET /settings/organisation` віддає лише поля картки наряду / замовлення постачальнику
 * (`OrganisationCardSettingsDto`), — рішення власника 2026-10-16 і 2026-10-18 (employee.md).
 */
const CARD_SETTINGS_ONLY_ROLES: ReadonlySet<string> = new Set([
  'MECHANIC',
  'RECEPTIONIST',
  'STOREKEEPER',
  'ACCOUNTANT',
]);

@ApiTags('Налаштування')
@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get('organisation')
  // MECHANIC і RECEPTIONIST — лише читання полів картки наряду (рішення власника 2026-10-16,
  // employee.md): ПДВ, валюта, мова, перерахунок годин і синхронізація запису календаря.
  // STOREKEEPER — ті самі поля для ПДВ картки замовлення постачальнику (рішення власника 2026-10-18:
  // без них картка комірника рахувала замовлення «без ПДВ» і сипала 403 у консоль).
  // ACCOUNTANT — ті самі поля: картка замовлення на перегляд (BR-PO-015, рішення власника 2026-10-30).
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Налаштування організації' })
  @ApiResponse({
    status: 200,
    type: OrganisationSettingsResponseDto,
    description:
      'MECHANIC, RECEPTIONIST, STOREKEEPER і ACCOUNTANT отримують лише поля картки (OrganisationCardSettingsDto)',
  })
  getOrganisation(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganisationSettingsResponseDto | OrganisationCardSettingsDto> {
    if (CARD_SETTINGS_ONLY_ROLES.has(user.role))
      return this.service.getOrganisationCardSettings(orgId);
    return this.service.getOrganisationSettings(orgId);
  }

  // UI feature flags must be readable by ALL authenticated roles
  // (work-orders page is shown to RECEPTIONIST/MECHANIC/ACCOUNTANT and
  // every such page mounts useUiFeatures). Restricting to OWNER/ADMIN
  // would force a 403 on every navigation for non-admin staff.
  @Get('ui-features')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'UI feature flags (доступно всім авторизованим)' })
  async getUiFeatures(@OrgContext() orgId: string): Promise<UiFeatures> {
    const settings = await this.service.getOrganisationSettings(orgId);
    return settings.uiFeatures;
  }

  // Базова валюта організації потрібна кожному екрану з грошима (каса, рахунки, наряди,
  // взаєморозрахунки) — символ валюти й колонка «у базовій». Повні налаштування організації
  // читають лише власник і адміністратор, тож бухгалтер і приймальня отримували 403 на кожному
  // такому екрані й лишались без базової валюти (Bug #847). Віддаємо ЛИШЕ код валюти.
  @Get('base-currency')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Базова валюта організації (доступно всім авторизованим)' })
  @ApiResponse({ status: 200, type: BaseCurrencyResponseDto })
  async getBaseCurrency(@OrgContext() orgId: string): Promise<BaseCurrencyResponseDto> {
    const settings = await this.service.getOrganisationSettings(orgId);
    return { currency: settings.currency };
  }

  // Палітра інтерфейсу й назва організації в шапці меню — при кожному завантаженні застосунку, у
  // КОЖНОЇ ролі; повні налаштування бухгалтеру закриті (як base-currency, Bug #847). Віддаємо ЛИШЕ їх.
  @Get('branding')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT', 'XLSX_MANAGER')
  @ApiOperation({
    summary: 'Палітра й назва організації для оболонки (доступно всім авторизованим)',
  })
  @ApiResponse({ status: 200, type: BrandingResponseDto })
  async getBranding(@OrgContext() orgId: string): Promise<BrandingResponseDto> {
    return this.service.getBranding(orgId);
  }

  @Patch('organisation')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування організації' })
  @ApiResponse({ status: 200, type: OrganisationSettingsResponseDto })
  updateOrganisation(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateOrganisationSettingsDto,
  ) {
    return this.service.updateOrganisationSettings(orgId, dto, user?.id);
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  getBranch(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.service.getBranchSettings(orgId, branchId);
  }

  @Get('work-hours')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({
    summary:
      'Робочі години філії: сітка календаря, пікер планових дат наряду (BR-WO-019). ' +
      'Без branchId — основна (перша) філія',
  })
  @ApiQuery({ name: 'branchId', required: false, description: 'Філія (UUID)' })
  @ApiResponse({ status: 200, type: WorkHoursDto })
  getWorkHours(
    @OrgContext() orgId: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.service.getWorkHours(orgId, branchId);
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  updateBranch(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchSettingsDto,
  ) {
    return this.service.updateBranchSettings(orgId, branchId, dto, user?.id);
  }

  @Get('document-numbers')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Конфігурації нумерації документів' })
  getDocNumbers(@OrgContext() orgId: string) {
    return this.service.getDocumentNumbers(orgId);
  }

  @Patch('document-numbers/:documentType')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити конфігурацію нумерації' })
  updateDocNumber(
    @OrgContext() orgId: string,
    @Param('documentType') documentType: string,
    @Body() dto: UpdateDocNumberDto,
  ) {
    return this.service.updateDocumentNumber(orgId, documentType, dto);
  }

  @Post('document-numbers/:documentType/reset')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Скинути лічильник нумерації' })
  resetDocNumber(@OrgContext() orgId: string, @Param('documentType') documentType: string) {
    return this.service.resetDocumentNumber(orgId, documentType);
  }

  @Get('tax-rates')
  // `private, no-cache`: the list is editable, and with `max-age=300` the browser kept serving the
  // pre-edit copy for up to 5 minutes after a save (Bug #299 class; brands - owner report 2026-10-12).
  // The server-side Redis cache, invalidated on every write, keeps the response fast.
  @Header('Cache-Control', 'private, no-cache')
  // MECHANIC і RECEPTIONIST — ставка ПДВ картки наряду (рішення власника 2026-10-16); STOREKEEPER —
  // ставка ПДВ картки замовлення постачальнику (2026-10-18); список без чутливих полів.
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER')
  @ApiOperation({ summary: 'Список ставок ПДВ' })
  getTaxRates(@OrgContext() orgId: string, @CurrentUser() user: AuthenticatedUser) {
    // `inUse` (BR-INV-027) потрібен лише вкладці НДІ, де ставку правлять OWNER/ADMIN; картки решти
    // ролей беруть сам список — без запиту по документах на кожне відкриття.
    if (CARD_SETTINGS_ONLY_ROLES.has(user.role)) return this.service.getTaxRates(orgId);
    return this.service.getTaxRatesWithUsage(orgId);
  }

  @Post('tax-rates')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити ставку ПДВ' })
  createTaxRate(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateTaxRateDto,
  ) {
    return this.service.createTaxRate(orgId, dto, user?.id);
  }

  @Patch('tax-rates/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити ставку ПДВ' })
  updateTaxRate(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    return this.service.updateTaxRate(orgId, id, dto, user?.id);
  }

  @Delete('tax-rates/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Видалити ставку ПДВ' })
  deleteTaxRate(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteTaxRate(orgId, id, user?.id);
  }

  @Get('org-info')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Дані організації (назва, адреси, лого, банк. рахунок)' })
  @ApiResponse({ status: 200, type: OrganisationResponseDto })
  getOrgInfo(@OrgContext() orgId: string) {
    return this.service.getOrganisation(orgId);
  }

  @Patch('org-info')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити дані організації' })
  @ApiResponse({ status: 200, type: OrganisationResponseDto })
  updateOrgInfo(@OrgContext() orgId: string, @Body() dto: UpdateOrganisationDto) {
    return this.service.updateOrganisation(orgId, dto);
  }
}
