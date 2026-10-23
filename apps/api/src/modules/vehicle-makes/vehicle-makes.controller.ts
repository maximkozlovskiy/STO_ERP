import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  vehicleDirectoryMergeSchema,
  vehicleMakeSchema,
  vehicleModelSchema,
  type VehicleDirectoryMergeValues,
  type VehicleMakeValues,
  type VehicleModelValues,
} from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  VehicleDirectoryMergeDto,
  VehicleDirectoryNameDto,
  VehicleMakeListResponseDto,
  VehicleMakeResponseDto,
  VehicleModelListResponseDto,
  VehicleModelResponseDto,
} from './vehicle-makes.dto';
import { VehicleMakesService } from './vehicle-makes.service';
import { VehicleModelsService } from './vehicle-models.service';

/**
 * BR-VEH-013. Читання — і механіку: він обирає марку й модель у формі авто. Видалення,
 * відновлення й злиття переписують авто інших людей — лише власник і адміністратор.
 */
export const VEHICLE_DIRECTORY_READ_ROLES = [
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'ACCOUNTANT',
  'MECHANIC',
] as const;
export const VEHICLE_DIRECTORY_WRITE_ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST'] as const;
export const VEHICLE_DIRECTORY_MANAGE_ROLES = ['OWNER', 'ADMIN'] as const;

@ApiTags('Марки авто')
@Controller('vehicle-makes')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class VehicleMakesController {
  constructor(
    private readonly makes: VehicleMakesService,
    private readonly models: VehicleModelsService,
  ) {}

  // `private, no-cache`: довідник редагується — серверний кеш Redis скидається записами, а
  // браузерний `max-age` показував би стару копію після збереження (як у counterparty-statuses).
  @Header('Cache-Control', 'private, no-cache')
  @Get()
  @Roles(...VEHICLE_DIRECTORY_READ_ROLES)
  @ApiOperation({ summary: 'Довідник марок авто' })
  @ApiQuery({ name: 'showDeleted', required: false, type: Boolean })
  @ApiResponse({ status: 200, type: VehicleMakeListResponseDto })
  findAll(@OrgContext() orgId: string, @Query('showDeleted') showDeleted?: string) {
    return this.makes.findAll(orgId, showDeleted === 'true');
  }

  @Post()
  @Roles(...VEHICLE_DIRECTORY_WRITE_ROLES)
  @ApiOperation({ summary: 'Додати марку' })
  @ApiBody({ type: VehicleDirectoryNameDto })
  @ApiResponse({ status: 201, type: VehicleMakeResponseDto })
  @ApiResponse({ status: 409, description: 'Марка з такою назвою вже є (жива чи видалена)' })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(vehicleMakeSchema)) dto: VehicleMakeValues,
  ) {
    return this.makes.create(orgId, dto);
  }

  @Header('Cache-Control', 'private, no-cache')
  @Get(':id/models')
  @Roles(...VEHICLE_DIRECTORY_READ_ROLES)
  @ApiOperation({ summary: 'Моделі марки' })
  @ApiQuery({ name: 'showDeleted', required: false, type: Boolean })
  @ApiResponse({ status: 200, type: VehicleModelListResponseDto })
  findModels(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('showDeleted') showDeleted?: string,
  ) {
    return this.models.findAll(orgId, id, showDeleted === 'true');
  }

  @Post(':id/models')
  @Roles(...VEHICLE_DIRECTORY_WRITE_ROLES)
  @ApiOperation({ summary: 'Додати модель марки' })
  @ApiBody({ type: VehicleDirectoryNameDto })
  @ApiResponse({ status: 201, type: VehicleModelResponseDto })
  createModel(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vehicleModelSchema)) dto: VehicleModelValues,
  ) {
    return this.models.create(orgId, id, dto);
  }

  @Post(':id/restore')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Відновити видалену марку (разом із моделями, видаленими з нею)' })
  @ApiResponse({ status: 200, type: VehicleMakeResponseDto })
  restore(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.makes.restore(orgId, id);
  }

  @Post(':id/merge')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Злити марку в іншу: авто й моделі переходять до цілі' })
  @ApiBody({ type: VehicleDirectoryMergeDto })
  @ApiResponse({ status: 200, type: VehicleMakeResponseDto })
  merge(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vehicleDirectoryMergeSchema)) dto: VehicleDirectoryMergeValues,
  ) {
    return this.makes.merge(orgId, id, dto.targetId);
  }

  @Patch(':id')
  @Roles(...VEHICLE_DIRECTORY_WRITE_ROLES)
  @ApiOperation({ summary: 'Перейменувати марку (назва оновлюється й в авто)' })
  @ApiBody({ type: VehicleDirectoryNameDto })
  @ApiResponse({ status: 200, type: VehicleMakeResponseDto })
  rename(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vehicleMakeSchema)) dto: VehicleMakeValues,
  ) {
    return this.makes.rename(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити марку (400, якщо її мають живі авто)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.makes.remove(orgId, id);
  }
}

@ApiTags('Марки авто')
@Controller('vehicle-models')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class VehicleModelsController {
  constructor(private readonly models: VehicleModelsService) {}

  @Post(':id/restore')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Відновити видалену модель' })
  @ApiResponse({ status: 200, type: VehicleModelResponseDto })
  restore(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.models.restore(orgId, id);
  }

  @Post(':id/merge')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Злити модель в іншу модель тієї ж марки' })
  @ApiBody({ type: VehicleDirectoryMergeDto })
  @ApiResponse({ status: 200, type: VehicleModelResponseDto })
  merge(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vehicleDirectoryMergeSchema)) dto: VehicleDirectoryMergeValues,
  ) {
    return this.models.merge(orgId, id, dto.targetId);
  }

  @Patch(':id')
  @Roles(...VEHICLE_DIRECTORY_WRITE_ROLES)
  @ApiOperation({ summary: 'Перейменувати модель (назва оновлюється й в авто)' })
  @ApiBody({ type: VehicleDirectoryNameDto })
  @ApiResponse({ status: 200, type: VehicleModelResponseDto })
  rename(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vehicleModelSchema)) dto: VehicleModelValues,
  ) {
    return this.models.rename(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(...VEHICLE_DIRECTORY_MANAGE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити модель (400, якщо її мають живі авто)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.models.remove(orgId, id);
  }
}
