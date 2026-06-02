import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SystemTemplateQueryDto {
  @ApiPropertyOptional({
    description: 'currency | unit_of_measure | payment_method | work_category',
  })
  @IsOptional()
  @IsString()
  entityType?: string;
}

export class SystemTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() data!: Record<string, unknown>;
  @ApiProperty() sortOrder!: number;
}
