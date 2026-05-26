import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SearchQueryDto {
  @ApiProperty({ description: 'Пошуковий запит', minLength: 2, maxLength: 100 })
  @IsString()
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
