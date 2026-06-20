import { ApiProperty } from '@nestjs/swagger';

// `fileKey` (internal MinIO path like `org/<uuid>/work-orders/<uuid>/<uuid>.jpg`) must never be
// included in responses — it exposes the bucket layout and org id. Frontend uses `signedUrl` only.
export class WorkOrderMediaResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
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
