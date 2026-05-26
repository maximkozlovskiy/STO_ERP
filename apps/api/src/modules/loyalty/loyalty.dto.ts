import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, Max } from 'class-validator';

export class RedeemLoyaltyDto {
  @ApiProperty({ example: 50, description: 'Кількість балів для списання' })
  @IsNumber()
  @Min(1)
  @Max(100_000)
  points!: number;
}
