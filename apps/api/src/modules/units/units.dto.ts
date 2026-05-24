import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({ example: 'штука' })
  @IsString() @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'шт' })
  @IsString() @IsNotEmpty()
  shortName!: string;
}

export class UpdateUnitDto {
  @ApiProperty({ example: 'штука' })
  @IsString() @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'шт' })
  @IsString() @IsNotEmpty()
  shortName!: string;
}

export class UnitResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() shortName!: string;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
