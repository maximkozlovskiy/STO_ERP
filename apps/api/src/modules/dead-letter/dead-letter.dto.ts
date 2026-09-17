import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsBooleanString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListDeadLetterQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional({ description: 'Ім’я черги (sms/checkbox/...)' })
  @IsOptional()
  @IsString()
  queueName?: string;
  @ApiPropertyOptional({ description: 'Лише нерозв’язані (false) / лише розв’язані (true)' })
  @IsOptional()
  @IsBooleanString()
  resolved?: string;
}

export class DeadLetterJobResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) orgId!: string | null;
  @ApiProperty() queueName!: string;
  @ApiProperty() jobName!: string;
  @ApiProperty() bullJobId!: string;
  @ApiProperty() attemptsMade!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty() failedReason!: string;
  @ApiProperty({ nullable: true }) stacktrace!: string | null;
  @ApiProperty() payload!: unknown;
  @ApiProperty() resolved!: boolean;
  @ApiProperty({ nullable: true }) resolvedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class PaginatedDeadLetterDto {
  @ApiProperty({ type: [DeadLetterJobResponseDto] }) items!: DeadLetterJobResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
