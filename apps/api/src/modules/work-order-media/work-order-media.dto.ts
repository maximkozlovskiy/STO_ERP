import { ApiProperty } from '@nestjs/swagger';

export class WorkOrderMediaResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() fileKey!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() uploadedBy!: string;
  @ApiProperty() signedUrl!: string;
  @ApiProperty() createdAt!: string;
}

export class WorkOrderMediaListDto {
  @ApiProperty({ type: [WorkOrderMediaResponseDto] }) items!: WorkOrderMediaResponseDto[];
  @ApiProperty() total!: number;
}
