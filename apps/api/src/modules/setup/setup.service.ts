import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { SetupInitDto, SetupInitResponseDto } from './setup.dto';

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async isAlreadyInitialized(): Promise<boolean> {
    const count = await this.prisma.organisation.count();
    return count > 0;
  }

  async init(dto: SetupInitDto): Promise<SetupInitResponseDto> {
    if (await this.isAlreadyInitialized()) {
      throw new BadRequestException('Систему вже налаштовано');
    }

    const passwordHash = await bcrypt.hash(dto.ownerPassword, 12);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Organisation
      const org = await tx.organisation.create({
        data: {
          name: dto.orgName,
          edrpou: dto.edrpou ?? null,
          orgId: '00000000-0000-0000-0000-000000000000', // temp
        },
      });

      // Fix self-reference: orgId = org.id
      await tx.organisation.update({
        where: { id: org.id },
        data: { orgId: org.id },
      });

      // 2. Organisation settings (defaults)
      await tx.organisationSettings.create({
        data: { orgId: org.id },
      });

      // 3. Default document number configs
      const docTypes = [
        'WORK_ORDER',
        'INVOICE',
        'PURCHASE_ORDER',
        'STOCK_RECEIPT',
        'STOCK_WRITEOFF',
        'STOCK_TRANSFER',
        'STOCK_OPENING',
        'RECONCILIATION_ACT',
      ] as const;

      const prefixMap: Record<string, string> = {
        WORK_ORDER: 'НЗ',
        INVOICE: 'РФ',
        PURCHASE_ORDER: 'ПО',
        STOCK_RECEIPT: 'ПТ',
        STOCK_WRITEOFF: 'СП',
        STOCK_TRANSFER: 'ПМ',
        STOCK_OPENING: 'ВЗ',
        RECONCILIATION_ACT: 'АС',
      };

      for (const docType of docTypes) {
        await tx.documentNumberConfig.create({
          data: {
            orgId: org.id,
            documentType: docType,
            prefix: prefixMap[docType] ?? null,
            resetPeriod: 'YEARLY',
          },
        });
      }

      // 4. Default payment methods
      const methods = [
        { code: 'cash', name: 'Готівка', sortOrder: 1, requiresFiscal: true },
        { code: 'card_terminal', name: 'Термінал', sortOrder: 2, requiresFiscal: true },
        { code: 'bank_transfer', name: 'Банківський переказ', sortOrder: 3, requiresFiscal: false },
        { code: 'privat24_qr', name: 'PrivatPay QR', sortOrder: 4, requiresFiscal: true },
        { code: 'monobank_qr', name: 'MonoPay QR', sortOrder: 5, requiresFiscal: true },
      ];
      for (const m of methods) {
        await tx.paymentMethodConfig.create({ data: { orgId: org.id, ...m } });
      }

      // 5. Default tax rates
      await tx.taxRate.createMany({
        data: [
          { orgId: org.id, name: 'Без ПДВ', rate: 0, isDefault: false },
          { orgId: org.id, name: 'ПДВ 20%', rate: 20, isDefault: true },
          { orgId: org.id, name: 'ПДВ 7%', rate: 7, isDefault: false },
        ],
      });

      // 6. Branch
      const branch = await tx.garageBranch.create({
        data: {
          orgId: org.id,
          name: dto.branchName,
          address: dto.branchAddress,
        },
      });

      // 7. Branch settings (defaults)
      await tx.branchSettings.create({
        data: { branchId: branch.id, orgId: org.id },
      });

      // 8. Warehouse
      const warehouse = await tx.warehouse.create({
        data: {
          orgId: org.id,
          branchId: branch.id,
          name: dto.warehouseName ?? 'Основний склад',
          type: 'MAIN',
        },
      });

      // 9. Owner employee
      const employee = await tx.employee.create({
        data: {
          orgId: org.id,
          firstName: dto.ownerFirstName,
          lastName: dto.ownerLastName,
          role: 'OWNER',
          rateScheme: { type: 'percent_normo', params: { percent: 40 } },
        },
      });

      // 10. AuthAccount
      await tx.authAccount.create({
        data: {
          orgId: org.id,
          employeeId: employee.id,
          email: dto.ownerEmail.toLowerCase(),
          passwordHash,
        },
      });

      return { org, branch, warehouse, employee };
    });

    const accessToken = this.authService.generateAccessToken({
      sub: result.employee.id,
      orgId: result.org.id,
      role: result.employee.role,
    });

    return {
      orgId: result.org.id,
      branchId: result.branch.id,
      warehouseId: result.warehouse.id,
      employeeId: result.employee.id,
      accessToken,
    };
  }
}
