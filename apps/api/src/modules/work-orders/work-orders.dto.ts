import { IsString, IsUUID, IsOptional, IsEnum, IsInt, IsNumber, Min, IsISO8601 } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { WorkOrderStatus } from '@prisma/client';

// ─── Work Order ───────────────────────────────────────────

export class CreateWorkOrderDto {
  @ApiProperty() @IsUUID() branchId!: string;
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() counterpartyId!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedAt?: string;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) inMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) outMileage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedAt?: string;
}

export class TransitionWorkOrderDto {
  @ApiProperty({ enum: WorkOrderStatus }) @IsEnum(WorkOrderStatus) status!: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class WorkOrderQueryDto {
  @ApiPropertyOptional({ enum: WorkOrderStatus }) @IsOptional() @IsEnum(WorkOrderStatus) status?: WorkOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;

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
  limit: number = 20;
}

export class WorkOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
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
  @ApiPropertyOptional() completedAt?: Date | null;
  @ApiProperty() totalLabor!: number;
  @ApiProperty() totalParts!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() paidAmount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedWorkOrdersDto {
  @ApiProperty({ type: [WorkOrderResponseDto] }) items!: WorkOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── Work Order Line ──────────────────────────────────────

export class CreateWorkOrderLineDto {
  @ApiProperty() @IsUUID() workId!: string;
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() liftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) normoHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateWorkOrderLineDto extends PartialType(CreateWorkOrderLineDto) {}

export class WorkOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() workId!: string;
  @ApiPropertyOptional() workName?: string;
  @ApiProperty() employeeId!: string;
  @ApiPropertyOptional() employeeName?: string;
  @ApiPropertyOptional() liftId?: string | null;
  @ApiProperty() normoHours!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: Date;
}

// ─── Work Order Part ──────────────────────────────────────

export class CreateWorkOrderPartDto {
  @ApiProperty() @IsUUID() goodId!: string;
  @ApiProperty() @IsUUID() warehouseId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
}

export class UpdateWorkOrderPartDto extends PartialType(CreateWorkOrderPartDto) {}

export class WorkOrderPartResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
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
