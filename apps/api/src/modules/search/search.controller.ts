import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { SearchService } from './search.service';
import { SearchResponseDto } from './search.dto';

const ALL_TYPES = ['wo', 'counterparty', 'good'] as const;
type SearchType = (typeof ALL_TYPES)[number];

@ApiTags('Search')
@Controller('search')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Повнотекстовий пошук по нарядах, клієнтах, товарах' })
  async search(
    @OrgContext() orgId: string,
    @Query('q') q: string,
    @Query('types') typesParam?: string,
    @Query('limit') limitParam?: string,
  ): Promise<SearchResponseDto> {
    if (!q || typeof q !== 'string' || q.length < 2) return { items: [], total: 0 };
    // Bound input length — pg_trgm `similarity()` is O(n*m) so a 100k-char `q` would
    // be both a DoS vector and an OOM risk against the GIN index.
    const safeQ = q.slice(0, 100);

    const limit = Math.min(Math.max(parseInt(limitParam ?? '10', 10) || 10, 1), 50);
    const types: SearchType[] = typesParam
      ? (typesParam.split(',').filter((t) => ALL_TYPES.includes(t as SearchType)) as SearchType[])
      : [...ALL_TYPES];

    if (types.length === 0) return { items: [], total: 0 };

    const items = await this.service.search(orgId, safeQ, types, limit);
    return { items, total: items.length };
  }
}
