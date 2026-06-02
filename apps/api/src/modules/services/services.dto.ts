import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
  IsPositive,
  IsOptional,
  IsUUID,
  IsArray,
  IsBoolean,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class ServiceWorkItemDto {
  @ApiProperty()
  @IsUUID()
  workId!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  quantity?: number;
}

export class ServiceGoodItemDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  quantity?: number;
}

export class CreateServiceDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ description: 'Фіксована ціна (null = авто-підрахунок)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ type: [ServiceWorkItemDto] })
  @IsOptional()
  @IsArray()
  // Bug #248: anti-DoS cap; реалістичний максимум robotic-операцій у послузі.
  @ArrayMaxSize(100, { message: 'Не більше 100 робіт у послузі' })
  @ValidateNested({ each: true })
  @Type(() => ServiceWorkItemDto)
  works?: ServiceWorkItemDto[];

  @ApiPropertyOptional({ type: [ServiceGoodItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: 'Не більше 100 запчастин у послузі' })
  @ValidateNested({ each: true })
  @Type(() => ServiceGoodItemDto)
  goods?: ServiceGoodItemDto[];
}

export class UpdateServiceDto extends PartialType(CreateServiceDto) {}

export class ServiceQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  showDeleted?: boolean;
}

export class ServiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() price!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: Date | null;
  @ApiProperty() works!: Array<{
    workId: string;
    workName: string;
    normoHours: number;
    price: number;
    quantity: number;
  }>;
  @ApiProperty() goods!: Array<{
    goodId: string;
    goodName: string;
    unit: string;
    salePrice: number;
    quantity: number;
  }>;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedServicesDto {
  @ApiProperty({ type: [ServiceResponseDto] }) items!: ServiceResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
