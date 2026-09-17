import { Controller, Get, Patch, Param, Query, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { DeadLetterService } from './dead-letter.service';

@ApiTags('DeadLetter')
@Controller('dead-letter')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class DeadLetterController {
  constructor(private readonly service: DeadLetterService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Dead-letter: job-и, що вичерпали всі спроби' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'queueName', required: false })
  @ApiQuery({ name: 'resolved', required: false, description: 'true=розв’язані, false=активні' })
  findAll(
    @OrgContext() orgId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('queueName') queueName?: string,
    @Query('resolved') resolved?: string,
  ) {
    const resolvedBool = resolved === 'true' ? true : resolved === 'false' ? false : undefined;
    return this.service.findAll(orgId, +page, +limit, queueName, resolvedBool);
  }

  @Patch(':id/resolve')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Позначити dead-letter запис опрацьованим' })
  resolve(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.resolve(orgId, id);
  }
}
