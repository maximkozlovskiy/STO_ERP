import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateCounterpartyStatusDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({ example: '#f59e0b', description: 'HEX-колір бейджа' })
  @IsOptional()
  @IsHexColor({ message: 'Колір має бути у форматі HEX (#rrggbb)' })
  color?: string;
}

export class UpdateCounterpartyStatusDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({ example: '#f59e0b', description: 'HEX-колір бейджа' })
  @IsOptional()
  @IsHexColor({ message: 'Колір має бути у форматі HEX (#rrggbb)' })
  color?: string;
}

export class CounterpartyStatusResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty({ description: 'Скільки контрагентів мають цей статус' }) counterpartyCount!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Призначення статусу контрагенту (POST /counterparties/:id/statuses). */
export class AssignCounterpartyStatusDto {
  @ApiProperty({ description: 'ID статусу для призначення' })
  @IsUUID()
  @IsNotEmpty()
  statusId!: string;
}
