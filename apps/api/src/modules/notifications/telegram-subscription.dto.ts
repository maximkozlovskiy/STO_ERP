import { ApiProperty } from '@nestjs/swagger';

/** Статус підписки на власний Telegram-бот у картці контрагента й працівника (BR-AUT-041). */
export class TelegramSubscriptionStatusDto {
  @ApiProperty({ description: 'Є активна підписка (бот надсилає в цей чат)' })
  active!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Коли підписався (ISO); null — підписки немає',
  })
  subscribedAt!: string | null;
}
