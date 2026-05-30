import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength, IsIn } from 'class-validator';

export const COMMENT_ENTITY_TYPES = ['WorkOrder', 'Counterparty', 'Vehicle', 'Invoice'] as const;
export type CommentEntityType = (typeof COMMENT_ENTITY_TYPES)[number];

export class CreateCommentDto {
  @ApiProperty({ enum: COMMENT_ENTITY_TYPES })
  @IsIn(COMMENT_ENTITY_TYPES)
  entityType!: CommentEntityType;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

export class CommentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty() entityId!: string;
  @ApiProperty() body!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() authorName!: string;
  @ApiProperty() createdAt!: string;
}

export class CommentsListResponseDto {
  @ApiProperty({ type: [CommentResponseDto] }) items!: CommentResponseDto[];
  @ApiProperty() total!: number;
}
