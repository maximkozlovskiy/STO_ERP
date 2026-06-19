import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsInt,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsISO8601,
  IsDateString,
  IsBoolean,
  IsBooleanString,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// в”Ђв”Ђв”Ђ Work Order в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateWorkOrderDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiProperty()
  @IsUUID()
  vehicleId!: string;
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;

  @ApiPropertyOptional({
    description:
      'Р”РѕРіРѕРІС–СЂ РєРѕРЅС‚СЂР°РіРµРЅС‚Р° (SALE). РђРІС‚Рѕ-РІРёР±С–СЂ СЏРєС‰Рѕ РЅРµ РїРµСЂРµРґР°РЅРѕ.',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;

  // Bug #257: emptyToUndefined gap вЂ” sprint cycle 3 РїСЂРѕРїСѓСЃС‚РёРІ work-orders DTO.
  // Frontend СЃРµР»РµРєС‚Рё С‰Рѕ С€Р»СЋС‚СЊ `''` РїСЂРё default state в†’ 400 Р±РµР· С‚СЂР°РЅСЃС„РѕСЂРјСѓ.
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @ApiPropertyOptional({ enum: RepairCategory })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RepairCategory)
  repairCategory?: RepairCategory;

  // Bug #258: emptyToUndefined gap вЂ” datetime-local input С€Р»Рµ `''` РїСЂРё reset в†’ 400.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  plannedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional({
    description:
      'Р”Р°С‚Р° РґРѕРєСѓРјРµРЅС‚Р° (YYYY-MM-DD), Р·Р° Р·Р°РјРѕРІС‡СѓРІР°РЅРЅСЏРј вЂ” СЃСЊРѕРіРѕРґРЅС–',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'РџС–РґР№РѕРјРЅРёРє' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;

  @ApiPropertyOptional({ description: 'РџР»Р°РЅРѕРІС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedHours?: number;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) outMileage?: number;

  // Bug #259: emptyToUndefined gap Сѓ PATCH-С€Р»СЏС…Сѓ.
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @ApiPropertyOptional({ enum: RepairCategory })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RepairCategory)
  repairCategory?: RepairCategory;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() clientApproval?: boolean;

  // Nullable: passing `null` explicitly clears the field; omitting keeps it.
  // emptyToUndefined: `''` РІС–Рґ UI С€Р»Рµ СЃРєРёРЅСѓС‚Рµ РїРѕР»Рµ в†’ undefined в†’ omit (keeps existing).
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  plannedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  dueDate?: string | null;

  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° РґРѕРєСѓРјРµРЅС‚Р° (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ description: 'РџС–РґР№РѕРјРЅРёРє', type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string | null;

  @ApiPropertyOptional({
    description: 'РџР»Р°РЅРѕРІС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedHours?: number | null;

  @ApiPropertyOptional({
    description: 'Р¤Р°РєС‚РёС‡РЅС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualHours?: number | null;
}

export class TransitionWorkOrderDto {
  @ApiProperty({ enum: WorkOrderStatus }) @IsEnum(WorkOrderStatus) status!: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class WorkOrderQueryDto {
  @ApiPropertyOptional({ enum: WorkOrderStatus })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;
  @ApiPropertyOptional({ enum: WorkOrderPriority })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  branchId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  counterpartyId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  vehicleId?: string;

  // F6: "РњРѕС— РЅР°СЂСЏРґРё" chip вЂ” filter by assigned mechanic. The filter joins through workOrderLines.employeeId,
  // so an employee sees an order if ANY of its line items reference them as the executor.
  @ApiPropertyOptional({
    description: 'Р¤С–Р»СЊС‚СЂ Р·Р° РІРёРєРѕРЅР°РІС†РµРј (С‡РµСЂРµР· СЂСЏРґРєРё СЂРѕР±С–С‚)',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    description: 'РџРѕС€СѓРє Р·Р° РЅРѕРјРµСЂРѕРј Р°Р±Рѕ РЅР°Р·РІРѕСЋ РєРѕРЅС‚СЂР°РіРµРЅС‚Р°',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: [
      'MAINTENANCE',
      'CURRENT_REPAIR',
      'MAJOR_REPAIR',
      'BODY_REPAIR',
      'DIAGNOSTICS',
      'WARRANTY',
      'SEASONAL',
    ],
  })
  @IsOptional()
  @IsEnum([
    'MAINTENANCE',
    'CURRENT_REPAIR',
    'MAJOR_REPAIR',
    'BODY_REPAIR',
    'DIAGNOSTICS',
    'WARRANTY',
    'SEASONAL',
  ])
  repairCategory?: string;

  @ApiPropertyOptional({ description: 'РџРѕРєР°Р·Р°С‚Рё РІРёРґР°Р»РµРЅС–' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

  // Bug #337: @IsISO8601() РїСЂРёР№РјР°С” datetime СЂСЏРґРєРё Р· С‡Р°СЃРѕРІРѕСЋ РєРѕРјРїРѕРЅРµРЅС‚РѕСЋ в†’ С…РёР±РЅР° С„С–Р»СЊС‚СЂР°С†С–СЏ.
  // @IsDateString() РїСЂРёР№РјР°С” Р»РёС€Рµ YYYY-MM-DD С„РѕСЂРјР°С‚ вЂ” РІС–РґРїРѕРІС–РґРЅРѕ РґРѕ СЂРµС€С‚Рё РјРѕРґСѓР»С–РІ.
  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° РґРѕРєСѓРјРµРЅС‚Р° РІС–Рґ (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° РґРѕРєСѓРјРµРЅС‚Р° РґРѕ (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'РџРѕР»Рµ СЃРѕСЂС‚СѓРІР°РЅРЅСЏ',
    enum: ['documentDate', 'createdAt', 'plannedAt', 'dueDate', 'totalAmount'],
  })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt', 'plannedAt', 'dueDate', 'totalAmount'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'РќР°РїСЂСЏРј СЃРѕСЂС‚СѓРІР°РЅРЅСЏ', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

export class WorkOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
  @ApiProperty({ enum: WorkOrderPriority }) priority!: WorkOrderPriority;
  @ApiPropertyOptional({ enum: RepairCategory }) repairCategory?: RepairCategory | null;
  @ApiProperty() branchId!: string;
  @ApiPropertyOptional() branchName?: string;
  @ApiProperty() vehicleId!: string;
  @ApiPropertyOptional() vehicleSummary?: string;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional({ description: 'Р”РѕРіРѕРІС–СЂ РєРѕРЅС‚СЂР°РіРµРЅС‚Р°' }) contractId?:
    | string
    | null;
  @ApiPropertyOptional() contractNumber?: string | null;
  @ApiPropertyOptional({ description: 'РџС–РґР№РѕРјРЅРёРє' }) liftId?: string | null;
  @ApiPropertyOptional({ description: 'РќР°Р·РІР° РїС–РґР№РѕРјРЅРёРєР°' }) liftName?: string | null;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() inMileage?: number | null;
  @ApiPropertyOptional() outMileage?: number | null;
  @ApiPropertyOptional() plannedAt?: string | null;
  @ApiPropertyOptional() dueDate?: string | null;
  @ApiPropertyOptional() plannedHours?: number | null;
  @ApiPropertyOptional() actualHours?: number | null;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiProperty() clientApproval!: boolean;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalActualLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() totalVat!: number;
  @ApiProperty() paidAmount!: number;
  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° РґРѕРєСѓРјРµРЅС‚Р°' }) documentDate?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Р„ Р°РєС‚РёРІРЅР° РіР°СЂР°РЅС‚С–СЏ' })
  hasActiveWarranty?: boolean;
  @ApiPropertyOptional({
    description: 'РќР°Р№Р±Р»РёР¶С‡РёР№ СЃР»РѕС‚ Сѓ РєР°Р»РµРЅРґР°СЂС–: РїРѕС‡Р°С‚РѕРє',
  })
  slotStartAt?: string | null;
  @ApiPropertyOptional({
    description: 'РќР°Р№Р±Р»РёР¶С‡РёР№ СЃР»РѕС‚ Сѓ РєР°Р»РµРЅРґР°СЂС–: РєС–РЅРµС†СЊ',
  })
  slotEndAt?: string | null;
  @ApiPropertyOptional({ description: 'РџС–РґР№РѕРјРЅРёРє СЃР»РѕС‚Р° Сѓ РєР°Р»РµРЅРґР°СЂС–' })
  slotLiftName?: string | null;
  @ApiPropertyOptional({ description: 'Set when the work order is soft-deleted' })
  deletedAt?: string | null;
}

export class PaginatedWorkOrdersDto {
  @ApiProperty({ type: [WorkOrderResponseDto] }) items!: WorkOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// в”Ђв”Ђв”Ђ Work Order Line в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateWorkOrderLineDto {
  @ApiProperty()
  @IsUUID()
  workId!: string;
  @ApiProperty()
  @IsUUID()
  employeeId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) normoHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) actualHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// Bug #521: actualHours РІРёРєР»СЋС‡Р°С”РјРѕ Р· PartialType Р±Рѕ РЅР°Рј РїРѕС‚СЂС–Р±РµРЅ С€РёСЂС€РёР№ С‚РёРї
// `number | null` (Р° CreateWorkOrderLineDto.actualHours = `number`). РџС–СЃР»СЏ Omit
// РґРѕРґР°С”РјРѕ СЏРІРЅСѓ РІРµСЂСЃС–СЋ Р· nullable handling.
export class UpdateWorkOrderLineDto extends PartialType(
  OmitType(CreateWorkOrderLineDto, ['actualHours'] as const),
) {
  // Bug #521: nullable handling вЂ” frontend save() РЅР°РґСЃРёР»Р°С” `null` РєРѕР»Рё РєРѕСЂРёСЃС‚СѓРІР°С‡
  // РѕС‡РёСЃС‚РёРІ inline "Р“РѕРґ (С„Р°РєС‚.)" в†’ Р±РµР· `ValidateIf(o => o.actualHours !== null)`
  // class-validator РєРёРґР°РІ 400 С– Р±СѓРґСЊ-СЏРєРёР№ save() Р· РїРѕСЂРѕР¶РЅС–Рј actualHours Р»Р°РіР°РІ
  // partial-PATCH (work-order СЂС–РІРµРЅСЊ РїСЂРѕР№С€РѕРІ, line PATCH вЂ” fail в†’ corrupted state).
  // РЎРёРјРµС‚СЂС–СЏ Р· UpdateWorkOrderDto.actualHours (work-orders.dto.ts:148) С‚Р° Bug #426.
  @ApiPropertyOptional({
    description: 'Р¤Р°РєС‚РёС‡РЅРѕ РІРёС‚СЂР°С‡РµРЅС– РіРѕРґРёРЅРё',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: { actualHours?: number | null }) => o.actualHours !== null)
  @IsNumber()
  @Min(0)
  actualHours?: number | null;
}

export class WorkOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() workId!: string;
  @ApiPropertyOptional() workName?: string;
  @ApiProperty() employeeId!: string;
  @ApiPropertyOptional() employeeName?: string;
  @ApiPropertyOptional() liftId?: string | null;
  @ApiProperty() normoHours!: number;
  @ApiPropertyOptional() actualHours?: number | null;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
}

// в”Ђв”Ђв”Ђ Work Order Part в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateWorkOrderPartDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional({
    description:
      'ID РѕРґРёРЅРёС†С– РІРёРјС–СЂСѓ Р· GoodUoM. РЇРєС‰Рѕ РЅРµ РїРµСЂРµРґР°РЅРѕ вЂ” Р±Р°Р·РѕРІР° РѕРґРёРЅРёС†СЏ С‚РѕРІР°СЂСѓ.',
  })
  @IsOptional()
  @IsUUID('4')
  unitOfMeasureId?: string;
}

export class UpdateWorkOrderPartDto extends PartialType(CreateWorkOrderPartDto) {}

export class WorkOrderPartResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() goodInternalCode?: string | null;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() goodBrandName?: string | null;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() costPrice?: number | null;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() createdAt!: string;
}

// в”Ђв”Ђв”Ђ Work Order Detail (full card) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class WorkOrderDetailDto extends WorkOrderResponseDto {
  @ApiProperty({ type: [WorkOrderLineResponseDto] }) lines!: WorkOrderLineResponseDto[];
  @ApiProperty({ type: [WorkOrderPartResponseDto] }) parts!: WorkOrderPartResponseDto[];
}

// в”Ђв”Ђв”Ђ Public Estimate (shared via shareToken вЂ” no auth) в”Ђв”Ђв”Ђв”Ђ
// IMPORTANT: С†РµР№ DTO РЅР°РІРјРёСЃРЅРѕ РќР• РјС–СЃС‚РёС‚СЊ orgId, РІСЃС– FK (vehicleId, counterpartyId,
// contractId, branchId, liftId, employeeId), paidAmount, clientApproval, slot*,
// outMileage, dueDate, syncVersion, deletedAt С‚РѕС‰Рѕ.
// Р’СЃРµ С‰Рѕ РєР»С–С”РЅС‚ Р±Р°С‡РёС‚СЊ РїСѓР±Р»С–С‡РЅРѕ вЂ” РѕР±РјРµР¶РµРЅРѕ РјС–РЅС–РјСѓРјРѕРј РґР»СЏ РґСЂСѓРєСѓ РєРѕС€С‚РѕСЂРёСЃСѓ.

export class EstimatePublicLineDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() workName?: string;
  @ApiProperty() normoHours!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() notes?: string | null;
}

export class EstimatePublicPartDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
}

export class EstimatePublicDto {
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
  @ApiPropertyOptional() orgName?: string;
  @ApiPropertyOptional() orgLogoUrl?: string | null;
  @ApiPropertyOptional() branchName?: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() vehicleSummary?: string;
  @ApiPropertyOptional() documentDate?: string | null;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() inMileage?: number | null;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ type: [EstimatePublicLineDto] }) lines!: EstimatePublicLineDto[];
  @ApiProperty({ type: [EstimatePublicPartDto] }) parts!: EstimatePublicPartDto[];
}

// в”Ђв”Ђв”Ђ Send estimate SMS (authenticated) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// baseUrl РЅР°РІРјРёСЃРЅРѕ РќР• РїСЂРёР№РјР°С”С‚СЊСЃСЏ Р· РєР»С–С”РЅС‚Р° (open-redirect/phishing СЂРёР·РёРє):
// СЃРµСЂРІРµСЂ СЃР°Рј РІРёР·РЅР°С‡Р°С” РїСѓР±Р»С–С‡РЅРёР№ URL С‡РµСЂРµР· ConfigService('WEB_PUBLIC_URL').

export class SendEstimateSmsDto {
  // РџРѕСЂРѕР¶РЅС” С‚С–Р»Рѕ вЂ” РЅР°РІРјРёСЃРЅРѕ. Р—Р°Р»РёС€РµРЅРѕ РґР»СЏ РјР°Р№Р±СѓС‚РЅС–С… РїР°СЂР°РјРµС‚СЂС–РІ (lang, channel),
  // class-validator Р·Р°Р±РµР·РїРµС‡РёС‚СЊ С‰Рѕ Р¶РѕРґРЅС– Р·Р°Р№РІС– РїРѕР»СЏ РЅРµ РїСЂРёР№РјР°СЋС‚СЊСЃСЏ (whitelist Сѓ ValidationPipe).
}

// в”Ђв”Ђв”Ђ Linked documents (batch counts) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// В§2.3 Input validation: Р±РµР· DTO @Body() РїСЂРёР№РјР°РІ РґРѕРІС–Р»СЊРЅРёР№ JSON в†’ DoS-РІРµРєС‚РѕСЂ
// (РјС–Р»СЊР№РѕРЅ IDs Сѓ where: { in: [...] } СЃРїСЂРёС‡РёРЅСЏС” РІР°Р¶РєРёР№ B-tree lookup) + РїРѕС‚РµРЅС†С–Р№РЅРѕ
// non-UUID Р·РЅР°С‡РµРЅРЅСЏ РґРѕС…РѕРґРёР»Рё РґРѕ Prisma. ArrayMaxSize РѕР±РјРµР¶СѓС” batch РґРѕ page-size+Р·Р°РїР°СЃ.

export class LinkedCountsDto {
  @ApiProperty({ type: [String], description: 'UUID РЅР°СЂСЏРґС–РІ (РјР°РєСЃ. 500)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  workOrderIds!: string[];
}
