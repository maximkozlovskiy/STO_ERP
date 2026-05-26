import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional, MaxLength, MinLength } from 'class-validator';

export class TemplateLineDto {
  @ApiProperty() workId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ required: false }) note?: string;
}

export class TemplatePartDto {
  @ApiProperty() goodId!: string;
  @ApiProperty() quantity!: number;
}

export class CreateWorkOrderTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ type: [TemplateLineDto], required: false })
  @IsOptional()
  @IsArray()
  lines?: TemplateLineDto[];

  @ApiProperty({ type: [TemplatePartDto], required: false })
  @IsOptional()
  @IsArray()
  parts?: TemplatePartDto[];
}

export class UpdateWorkOrderTemplateDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ type: [TemplateLineDto], required: false })
  @IsOptional()
  @IsArray()
  lines?: TemplateLineDto[];

  @ApiProperty({ type: [TemplatePartDto], required: false })
  @IsOptional()
  @IsArray()
  parts?: TemplatePartDto[];
}

export class WorkOrderTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() lines!: TemplateLineDto[];
  @ApiProperty() parts!: TemplatePartDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class WorkOrderTemplatesListDto {
  @ApiProperty({ type: [WorkOrderTemplateResponseDto] }) items!: WorkOrderTemplateResponseDto[];
  @ApiProperty() total!: number;
}
