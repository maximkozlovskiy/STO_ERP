import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiParam } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WorkOrderMediaService } from './work-order-media.service';
import { WorkOrderMediaListDto, WorkOrderMediaResponseDto } from './work-order-media.dto';

@ApiTags('work-order-media')
@Controller('work-orders/:workOrderId/media')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WorkOrderMediaController {
  constructor(private readonly service: WorkOrderMediaService) {}

  @Post()
  @Roles('OWNER', 'ADMIN', 'MECHANIC', 'RECEPTIONIST', 'STOREKEEPER')
  @ApiOperation({ summary: 'Завантажити фото до наряду' })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'workOrderId', type: String })
  async upload(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Req() req: FastifyRequest,
  ): Promise<WorkOrderMediaResponseDto> {
    if (!req.isMultipart()) {
      throw new BadRequestException('Очікується multipart/form-data');
    }

    // Hard cap у controller (memory-safe): абортуємо stream щойно перевищено ліміт
    // ще ДО того як вся бінарка опиниться у пам'яті процесу. Service.upload() робить
    // фінальну перевірку — це лише швидкий defense-in-depth для DoS-кейсу:
    // attacker завантажує 1 GB → без cap у controller, увесь чанк осідає у Node heap
    // (Buffer.concat має навіть піковий розмір 2×N під час allocation), і only ТОДІ
    // service кидає 400. Cap нижче дорівнює MAX_SIZE_BYTES сервісу + 1 KB headers slack.
    const HARD_CAP_BYTES = 10 * 1024 * 1024 + 1024;

    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let filename = 'photo.jpg';
    let mimetype = 'image/jpeg';
    let size = 0;

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        let accumulated = 0;
        for await (const chunk of part.file) {
          accumulated += chunk.length;
          if (accumulated > HARD_CAP_BYTES) {
            throw new BadRequestException('Файл завеликий (максимум 10 МБ)');
          }
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename;
        mimetype = part.mimetype;
        size = fileBuffer.length;
      }
    }

    if (!fileBuffer) throw new BadRequestException('Файл не отримано');

    return this.service.upload(orgId, workOrderId, user.id, {
      buffer: fileBuffer,
      filename,
      mimetype,
      size,
    });
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'MECHANIC', 'RECEPTIONIST', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Отримати фото наряду' })
  @ApiParam({ name: 'workOrderId', type: String })
  findAll(
    @OrgContext() orgId: string,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
  ): Promise<WorkOrderMediaListDto> {
    return this.service.findAll(orgId, workOrderId);
  }

  @Delete(':mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'MECHANIC', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Видалити фото наряду' })
  @ApiParam({ name: 'workOrderId', type: String })
  @ApiParam({ name: 'mediaId', type: String })
  remove(
    @OrgContext() orgId: string,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Param('mediaId', new ParseUUIDPipe()) mediaId: string,
  ): Promise<void> {
    return this.service.remove(orgId, workOrderId, mediaId);
  }
}
