import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpsertUserPreferenceDto {
  @ApiProperty({ description: 'Ключ налаштування', maxLength: 200 })
  @IsString()
  @IsNotEmpty({ message: 'Ключ не може бути порожнім' })
  @MaxLength(200)
  key!: string;

  @ApiProperty({ description: 'Значення (JSON-об\'єкт)' })
  value!: Record<string, unknown>;
}

export class UserPreferenceResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  value!: Record<string, unknown>;
}
