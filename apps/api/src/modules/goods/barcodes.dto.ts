import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsBoolean, IsOptional } from 'class-validator';

export class CreateGoodBarcodeDto {
  @ApiProperty({ example: '4820000000000' })
  @IsString()
  @IsNotEmpty()
  barcode!: string;

  @ApiProperty({ example: 'EAN13' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;
}

export class GoodBarcodeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() goodId!: string;
  @ApiProperty() barcode!: string;
  @ApiProperty() type!: string;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty() createdAt!: string;
}
