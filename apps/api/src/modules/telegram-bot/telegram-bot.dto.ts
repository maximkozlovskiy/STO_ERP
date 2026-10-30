import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Формат токена BotFather: `<id бота>:<секрет>`. Токен іде в шлях запиту до Bot API — сувора
 * перевірка формату не пускає туди `/`, `?` чи `..` (BR-AUT-040).
 */
export const TELEGRAM_BOT_TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;

export class ConnectTelegramBotDto {
  @ApiProperty({
    description: 'Токен бота від @BotFather (лише запис — у відповіді не повертається)',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(130)
  @Matches(TELEGRAM_BOT_TOKEN_RE, { message: 'err.telegramBot.invalidToken' })
  token!: string;
}

/** Стан підключення бота (BR-AUT-040). Токен не віддається ніколи. */
export class TelegramBotStatusDto {
  @ApiProperty() connected!: boolean;
  @ApiProperty({ type: String, nullable: true, description: "Ім'я бота (@username) для посилань" })
  username!: string | null;
}

/** Персональне посилання підписки (BR-AUT-041): одноразовий код на 7 днів. */
export class TelegramLinkDto {
  @ApiProperty({ description: 'Одноразовий код (параметр start)' }) code!: string;
  @ApiProperty({ description: 'https://t.me/<бот>?start=<код> — і для QR' }) url!: string;
  @ApiProperty({ description: 'Код діє до (ISO)' }) expiresAt!: string;
}
