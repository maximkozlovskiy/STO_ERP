import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SearchQueryDto {
  @ApiProperty({ description: 'Пошуковий запит', minLength: 2, maxLength: 100 })
  @IsString()
  // Bug #117: trigram similarity becomes meaningless and CPU-heavy below 2 chars.
  @MinLength(2, { message: 'Запит має містити мінімум 2 символи' })
  @MaxLength(100)
  q!: string;

  @ApiProperty({ required: false, description: 'Типи: wo,counterparty,good (через кому)' })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiProperty({ required: false, default: 10 })
  @IsOptional()
  limit?: string;
}

export class SearchResultItemDto {
  @ApiProperty() type!: string;
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ required: false }) sub?: string;
  @ApiProperty({ required: false }) extra?: Record<string, unknown>;
}

export class SearchResponseDto {
  @ApiProperty({ type: [SearchResultItemDto] }) items!: SearchResultItemDto[];
  @ApiProperty() total!: number;
}
