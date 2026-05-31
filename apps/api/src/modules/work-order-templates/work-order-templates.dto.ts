import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  MaxLength,
  MinLength,
  IsUUID,
  IsNumber,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

// Bug #247: вкладені DTO без декораторів пропускали свавільні значення (workId без UUID,
// quantity < 0, note довжиною 1М символів). `lines` / `parts` без @ArrayMaxSize дозволяли
// DoS через мільйонні масиви. Тепер усі поля валідуються; масиви обмежені 200 елементами
// (реалістичний максимум для нормо-карти).
export class TemplateLineDto {
  @ApiProperty()
  @IsUUID()
  workId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class TemplatePartDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  quantity!: number;
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
  @ArrayMaxSize(200, { message: 'Не більше 200 рядків робіт у шаблоні' })
  @ValidateNested({ each: true })
  @Type(() => TemplateLineDto)
  lines?: TemplateLineDto[];

  @ApiProperty({ type: [TemplatePartDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: 'Не більше 200 запчастин у шаблоні' })
  @ValidateNested({ each: true })
  @Type(() => TemplatePartDto)
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
  @ArrayMaxSize(200, { message: 'Не більше 200 рядків робіт у шаблоні' })
  @ValidateNested({ each: true })
  @Type(() => TemplateLineDto)
  lines?: TemplateLineDto[];

  @ApiProperty({ type: [TemplatePartDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: 'Не більше 200 запчастин у шаблоні' })
  @ValidateNested({ each: true })
  @Type(() => TemplatePartDto)
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
