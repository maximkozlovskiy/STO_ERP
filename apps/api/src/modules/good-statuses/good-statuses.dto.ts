import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateGoodStatusDto {
  @ApiProperty({ example: 'Акція' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({ example: '#f59e0b', description: 'HEX-колір бейджа' })
  @IsOptional()
  @IsHexColor({ message: 'err.dto.goodStatus.color.hex' })
  color?: string;
}

export class UpdateGoodStatusDto {
  @ApiProperty({ example: 'Акція' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({ example: '#f59e0b', description: 'HEX-колір бейджа' })
  @IsOptional()
  @IsHexColor({ message: 'err.dto.goodStatus.color.hex' })
  color?: string;
}

export class GoodStatusResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty({ description: 'Скільки товарів мають цей статус' }) goodCount!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Призначення статусу товару (POST /goods/:id/statuses). */
export class AssignGoodStatusDto {
  @ApiProperty({ description: 'ID статусу для призначення' })
  @IsUUID()
  @IsNotEmpty()
  statusId!: string;
}
