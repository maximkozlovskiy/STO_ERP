import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@sto.local' })
  @IsEmail({}, { message: 'Невірний формат email' })
  email!: string;

  @ApiProperty({ example: 'secret' })
  @IsString()
  @IsNotEmpty({ message: 'Пароль не може бути порожнім' })
  @MinLength(4, { message: 'Пароль занадто короткий' })
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiPropertyOptional()
  employee?: {
    id: string;
    orgId: string;
    firstName: string;
    lastName: string;
    role: string;
  };
}

export class JwtPayload {
  sub!: string;
  orgId!: string;
  role!: string;
  branchId?: string;
  // B1: версія токена на момент видачі. jwt.strategy порівнює з поточним AuthAccount.tokenVersion —
  // після logout-all/зміни пароля версія розходиться → 401. Опційне для сумісності зі старими
  // токенами у польоті (undefined трактується як 0 при порівнянні).
  tokenVersion?: number;
}
