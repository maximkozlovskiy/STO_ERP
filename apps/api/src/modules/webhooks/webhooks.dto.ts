import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ArrayMaxSize,
  IsIn,
} from 'class-validator';

export const WEBHOOK_EVENTS = ['WO_STATUS_CHANGED', 'PAYMENT_RECEIVED', 'LOW_STOCK_ALERT'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export class CreateWebhookDto {
  @ApiProperty()
  @IsUrl({ require_tld: false })
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret?: string;

  @ApiProperty({ type: [String], enum: WEBHOOK_EVENTS })
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events!: string[];
}

export class UpdateWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class WebhookEndpointResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() url!: string;
  @ApiProperty() events!: string[];
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
}

export class WebhookDeliveryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() event!: string;
  @ApiProperty() status!: string;
  @ApiProperty() attempts!: number;
  @ApiPropertyOptional() responseCode?: number | null;
  @ApiProperty() createdAt!: string;
}
