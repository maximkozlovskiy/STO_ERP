import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { MultipartFile } from '@fastify/multipart';
import { translateError } from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { getLocale } from '../../common/tenant/tenant-context';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BankStatementParserService, type ColumnMapping } from './bank-statement-parser.service';
import {
  ApplyImportDto,
  IgnoreTransactionDto,
  ListQueryDto,
  MatchTransactionDto,
  RawPreviewResponseDto,
  PreviewImportResponseDto,
  ApplyImportResultDto,
  BankTransactionResponseDto,
  PaginatedBankTransactionsDto,
  CreateBankTransactionDto,
  ReconcileTransactionDto,
  UnreconcileTransactionDto,
  SupplierPaymentCandidateDto,
} from './bank-statement.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('Bank Statements')
@Controller('bank-statements')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BankStatementsController {
  constructor(
    private readonly reconciliation: BankReconciliationService,
    private readonly parser: BankStatementParserService,
  ) {}

  // ─── Import: raw preview (сира сітка для column-mapping) ────────────────────────

  @Post('import/raw-preview')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Сирий передперегляд виписки (перші рядки як текстова сітка)' })
  @ApiOkResponse({ type: RawPreviewResponseDto })
  @ApiConsumes('multipart/form-data')
  async rawPreview(@Request() req: FastifyRequest) {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    return this.parser.rawPreview(buffer, file.filename ?? '', 50);
  }

  // ─── Import: preview (авто-матч) ────────────────────────────────────────────────

  @Post('import/preview')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Прев’ю імпорту виписки з авто-матчем контрагентів' })
  @ApiOkResponse({ type: PreviewImportResponseDto })
  @ApiConsumes('multipart/form-data')
  async preview(@OrgContext() orgId: string, @Request() req: FastifyRequest) {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const fields =
      (file as unknown as { fields?: Record<string, { value?: unknown }> }).fields ?? {};
    const num = (k: string): number | undefined => {
      const v = fields[k]?.value;
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
    };
    const str = (k: string): string => String(fields[k]?.value ?? '').trim();

    const bankAccountId = str('bankAccountId');
    if (!UUID_RE.test(bankAccountId)) {
      throw new BadRequestException(
        translateError('err.bankStatement.bankAccountNotFound', getLocale()),
      );
    }
    const mapping = this.buildMapping(num);
    const rows = await this.parser.parseRows(buffer, file.filename ?? '', mapping);
    const previewRows = await this.reconciliation.previewImport(orgId, bankAccountId, rows);
    return { rows: previewRows };
  }

  // ─── Import: apply (створення staging-транзакцій) ───────────────────────────────

  @Post('import/apply')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Застосувати імпорт виписки (створити банк-транзакції)' })
  @ApiOkResponse({ type: ApplyImportResultDto })
  async apply(@OrgContext() orgId: string, @Body() dto: ApplyImportDto) {
    return this.reconciliation.applyImport(orgId, dto);
  }

  // ─── List ────────────────────────────────────────────────────────────────────

  @Get('transactions')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список банк-транзакцій (виписка)' })
  @ApiOkResponse({ type: PaginatedBankTransactionsDto })
  async list(@OrgContext() orgId: string, @Query() query: ListQueryDto) {
    return this.reconciliation.list(orgId, query);
  }

  // ─── Ручне внесення (BR-BANK-023 / 024) ─────────────────────────────────────

  @Post('transactions')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @UseInterceptors(IdempotencyInterceptor) // повтор запиту з тим самим ключем не створює другий платіж
  @ApiOperation({ summary: 'Внести банківський платіж вручну (вхідний або вихідний)' })
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async createManual(
    @OrgContext() orgId: string,
    @Body() dto: CreateBankTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reconciliation.createManual(orgId, dto, user.id);
  }

  @Delete('transactions/:id')
  @HttpCode(204)
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Видалити внесений вручну нерознесений платіж' })
  async removeManual(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.reconciliation.removeManual(orgId, id);
  }

  // ─── Рознесення вихідних (BR-BANK-025…039) ──────────────────────────────────

  @Get('transactions/:id/supplier-payment-candidates')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Проведені оплати постачальникам, до яких можна прив’язати вихідний платіж',
  })
  @ApiOkResponse({ type: [SupplierPaymentCandidateDto] })
  async supplierPaymentCandidates(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reconciliation.listSupplierPaymentCandidates(orgId, id);
  }

  @Post('transactions/:id/reconcile')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({
    summary:
      'Рознести платіж: оплата постачальнику, повернення клієнту, витрата, зарплата, переказ, зняття готівки',
  })
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async reconcile(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reconciliation.reconcile(orgId, id, dto, user.id);
  }

  @Post('transactions/:id/unreconcile')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Скасувати рознесення платежу (причина обов’язкова)' })
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async unreconcile(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnreconcileTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reconciliation.unreconcile(orgId, id, dto, user.id);
  }

  // ─── Match / Ignore ─────────────────────────────────────────────────────────

  @Post('transactions/:id/match')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Рознести транзакцію на контрагента (створити платіж)' })
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async match(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MatchTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reconciliation.matchTransaction(orgId, id, dto, user.id);
  }

  @Post('transactions/:id/ignore')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Позначити транзакцію нерелевантною (ігнорувати)' })
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async ignore(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IgnoreTransactionDto,
  ) {
    return this.reconciliation.ignoreTransaction(orgId, id, dto);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private buildMapping(num: (k: string) => number | undefined): ColumnMapping {
    const dateCol = num('dateCol');
    const amountCol = num('amountCol');
    const externalIdCol = num('externalIdCol');
    if (!dateCol || !amountCol || !externalIdCol) {
      throw new BadRequestException(translateError('err.bankStatement.invalidFile', getLocale()));
    }
    return {
      startRow: num('startRow') ?? 1,
      dateCol,
      amountCol,
      externalIdCol,
      payerNameCol: num('payerNameCol'),
      payerIbanCol: num('payerIbanCol'),
      payerEdrpouCol: num('payerEdrpouCol'),
      purposeCol: num('purposeCol'),
    };
  }

  private async getUploadedFile(req: FastifyRequest): Promise<MultipartFile> {
    let data: MultipartFile | undefined;
    try {
      data = await req.file();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      throw new BadRequestException(
        msg.includes('not multipart')
          ? translateError('err.bankStatement.invalidFile', getLocale())
          : translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
    if (!data) {
      throw new BadRequestException(translateError('err.bankStatement.invalidFile', getLocale()));
    }
    return data;
  }
}
