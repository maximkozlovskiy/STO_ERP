import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateReconciliationActDto {
  @ApiProperty({ example: '2026-01-01' }) @IsDateString() periodFrom!: string;
  @ApiProperty({ example: '2026-12-31' }) @IsDateString() periodTo!: string;
}
