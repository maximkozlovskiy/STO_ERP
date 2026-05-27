import { ApiProperty } from '@nestjs/swagger';

// Bug #93: `fileKey` (internal MinIO object path like `org/<uuid>/work-orders/<uuid>/<uuid>.jpg`)
// was leaking on every response. The frontend only consumes `signedUrl` — keep it that way to
// avoid disclosing the bucket layout (org id appears verbatim in the key).
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
