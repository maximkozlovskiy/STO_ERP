import { Module } from '@nestjs/common';
import { VehicleMakesController, VehicleModelsController } from './vehicle-makes.controller';
import { VehicleMakesService } from './vehicle-makes.service';
import { VehicleModelsService } from './vehicle-models.service';

@Module({
  controllers: [VehicleMakesController, VehicleModelsController],
  providers: [VehicleMakesService, VehicleModelsService],
})
export class VehicleMakesModule {}
