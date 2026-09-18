import { Injectable, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  ImportMappingResponseDto,
  UpsertImportMappingDto,
} from './counterparty-import-mappings.dto';

/**
 * Персист мапінгу колонок Excel per-контрагент (майстер завантаження товарів).
 * Дзеркалить ProviderConfigService.upsertConfig: окрема таблиця, @@unique (counterpartyId 1:1),
 * атомарний prisma.upsert. Tenant-guard: counterparty валідується у org перед upsert.
 */
@Injectable()
export class CounterpartyImportMappingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string, counterpartyId: string): Promise<ImportMappingResponseDto> {
    await this.assertCounterpartyInOrg(orgId, counterpartyId);
    const mapping = await this.prisma.counterpartyImportMapping.findFirst({
      where: { orgId, counterpartyId, deletedAt: null },
    });
    if (!mapping) {
      // Дефолт (ще не збережено): порожній мапінг зі startRow=2.
      return {
        counterpartyId,
        startRow: 2,
        codeCol: null,
        articleCol: null,
        brandCol: null,
        nameCol: null,
        quantityCol: null,
        priceCol: null,
      };
    }
    return this.toDto(mapping);
  }

  async upsert(
    orgId: string,
    counterpartyId: string,
    dto: UpsertImportMappingDto,
  ): Promise<ImportMappingResponseDto> {
    await this.assertCounterpartyInOrg(orgId, counterpartyId);
    const data = {
      startRow: dto.startRow ?? 2,
      codeCol: dto.codeCol ?? null,
      articleCol: dto.articleCol ?? null,
      brandCol: dto.brandCol ?? null,
      nameCol: dto.nameCol ?? null,
      quantityCol: dto.quantityCol ?? null,
      priceCol: dto.priceCol ?? null,
      deletedAt: null,
    };
    const row = await this.prisma.counterpartyImportMapping.upsert({
      where: { counterpartyId },
      create: { orgId, counterpartyId, ...data },
      update: data,
    });
    return this.toDto(row);
  }

  private async assertCounterpartyInOrg(orgId: string, counterpartyId: string): Promise<void> {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp)
      throw new NotFoundException(
        translateError('err.counterpartyImportMapping.counterpartyNotFound', getLocale()),
      );
  }

  private toDto(m: {
    counterpartyId: string;
    startRow: number;
    codeCol: number | null;
    articleCol: number | null;
    brandCol: number | null;
    nameCol: number | null;
    quantityCol: number | null;
    priceCol: number | null;
  }): ImportMappingResponseDto {
    return {
      counterpartyId: m.counterpartyId,
      startRow: m.startRow,
      codeCol: m.codeCol,
      articleCol: m.articleCol,
      brandCol: m.brandCol,
      nameCol: m.nameCol,
      quantityCol: m.quantityCol,
      priceCol: m.priceCol,
    };
  }
}
