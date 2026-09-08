import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsBooleanString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListIntegrationLogsQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional({ description: 'Код провайдера' })
  @IsOptional()
  @IsString()
  provider?: string;
  @ApiPropertyOptional({ description: 'Операція (ім’я методу)' })
  @IsOptional()
  @IsString()
  operation?: string;
  @ApiPropertyOptional({ description: 'Лише успіх (true) / лише помилки (false)' })
  @IsOptional()
  @IsBooleanString()
  ok?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() documentType?: string;
  @ApiPropertyOptional({ description: 'Дата від (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  dateFrom?: string;
  @ApiPropertyOptional({ description: 'Дата до (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  dateTo?: string;
}

export class IntegrationLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) branchId!: string | null;
  @ApiProperty() provider!: string;
  @ApiProperty() operation!: string;
  @ApiProperty() ok!: boolean;
  @ApiProperty({ nullable: true }) httpStatus!: number | null;
  @ApiProperty({ nullable: true }) durationMs!: number | null;
  @ApiProperty({ nullable: true }) documentType!: string | null;
  @ApiProperty({ nullable: true }) documentId!: string | null;
  @ApiProperty({ nullable: true }) error!: string | null;
  @ApiProperty() createdAt!: string;
}

export class PaginatedIntegrationLogsDto {
  @ApiProperty({ type: [IntegrationLogResponseDto] }) items!: IntegrationLogResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
