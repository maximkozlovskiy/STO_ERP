import { IsString, IsNotEmpty, MaxLength, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpsertUserPreferenceDto {
  @ApiProperty({ description: 'Ключ налаштування', maxLength: 200 })
  @IsString()
  @IsNotEmpty({ message: 'Ключ не може бути порожнім' })
  @MaxLength(200)
  key!: string;

  @ApiProperty({ description: 'Значення (JSON-об\'єкт)' })
  @IsObject({ message: 'Значення має бути об\'єктом' })
  value!: Record<string, unknown>;
}

export class UserPreferenceResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  value!: Record<string, unknown>;
}
