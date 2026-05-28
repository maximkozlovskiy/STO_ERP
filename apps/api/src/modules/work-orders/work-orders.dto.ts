import { IsString, IsUUID, Matches, IsOptional, IsEnum, IsInt, IsNumber, Min, Max, IsISO8601, IsBoolean, IsBooleanString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';

// ─── Work Order ───────────────────────────────────────────

export class CreateWorkOrderDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) branchId!: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) vehicleId!: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) counterpartyId!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsEnum(WorkOrderPriority) priority?: WorkOrderPriority;
  @ApiPropertyOptional() @IsOptional() @IsEnum(RepairCategory) repairCategory?: RepairCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueDate?: string;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) outMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsEnum(WorkOrderPriority) priority?: WorkOrderPriority;
  @ApiPropertyOptional() @IsOptional() @IsEnum(RepairCategory) repairCategory?: RepairCategory;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() clientApproval?: boolean;

  // Nullable: passing `null` explicitly clears the field; omitting keeps it.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsISO8601()
  plannedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsISO8601()
  dueDate?: string | null;
}

export class TransitionWorkOrderDto {
  @ApiProperty({ enum: WorkOrderStatus }) @IsEnum(WorkOrderStatus) status!: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class WorkOrderQueryDto {
  @ApiPropertyOptional({ enum: WorkOrderStatus }) @IsOptional() @IsEnum(WorkOrderStatus) status?: WorkOrderStatus;
  @ApiPropertyOptional({ enum: WorkOrderPriority }) @IsOptional() @IsEnum(WorkOrderPriority) priority?: WorkOrderPriority;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) branchId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) vehicleId?: string;

  // F6: "Мої наряди" chip — filter by assigned mechanic. The filter joins through workOrderLines.employeeId,
  // so an employee sees an order if ANY of its line items reference them as the executor.
  @ApiPropertyOptional({ description: 'Фільтр за виконавцем (через рядки робіт)' })
  @IsOptional()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Пошук за номером або назвою контрагента' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ['MAINTENANCE', 'CURRENT_REPAIR', 'MAJOR_REPAIR', 'BODY_REPAIR', 'DIAGNOSTICS', 'WARRANTY', 'SEASONAL'] })
  @IsOptional()
  @IsEnum(['MAINTENANCE', 'CURRENT_REPAIR', 'MAJOR_REPAIR', 'BODY_REPAIR', 'DIAGNOSTICS', 'WARRANTY', 'SEASONAL'])
  repairCategory?: string;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

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
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() inMileage?: number | null;
  @ApiPropertyOptional() outMileage?: number | null;
  @ApiPropertyOptional() plannedAt?: Date | null;
  @ApiPropertyOptional() dueDate?: Date | null;
  @ApiPropertyOptional() completedAt?: Date | null;
  @ApiProperty() clientApproval!: boolean;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() paidAmount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ description: 'Є активна гарантія' }) hasActiveWarranty?: boolean;
}

export class PaginatedWorkOrdersDto {
  @ApiProperty({ type: [WorkOrderResponseDto] }) items!: WorkOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── Work Order Line ──────────────────────────────────────

export class CreateWorkOrderLineDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) workId!: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) employeeId!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) liftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) normoHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) actualHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateWorkOrderLineDto extends PartialType(CreateWorkOrderLineDto) {
  @ApiPropertyOptional({ description: 'Фактично витрачені години' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualHours?: number;
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
  @ApiProperty() createdAt!: Date;
}

// ─── Work Order Part ──────────────────────────────────────

export class CreateWorkOrderPartDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) goodId!: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) warehouseId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
}

export class UpdateWorkOrderPartDto extends PartialType(CreateWorkOrderPartDto) {}

export class WorkOrderPartResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() createdAt!: Date;
}

// ─── Work Order Detail (full card) ───────────────────────

export class WorkOrderDetailDto extends WorkOrderResponseDto {
  @ApiProperty({ type: [WorkOrderLineResponseDto] }) lines!: WorkOrderLineResponseDto[];
  @ApiProperty({ type: [WorkOrderPartResponseDto] }) parts!: WorkOrderPartResponseDto[];
}
