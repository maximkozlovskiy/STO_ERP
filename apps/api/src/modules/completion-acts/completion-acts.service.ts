import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CompletionActStatus } from '@prisma/client';
import { formatPersonName, formatVehicleLabel, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PdfService } from '../pdf/pdf.service';
import {
  CompletionActResponseDto,
  CompletionActLineDto,
  SignCompletionActDto,
  PaginatedCompletionActsDto,
} from './completion-acts.dto';

@Injectable()
export class CompletionActsService {
  private readonly logger = new Logger(CompletionActsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly invoices: InvoicesService,
    private readonly pdf: PdfService,
  ) {}

  async findAll(orgId: string, workOrderId?: string): Promise<PaginatedCompletionActsDto> {
    // Bug #275: CANCELLED acts мають бути виключені з активного списку.
    // cancel() не робить soft-delete (deletedAt лишається null) — тільки змінює status.
    // Без цього фронт після cancel перезавантажує сторінку → бачить «прихований» CANCELLED act
    // у списку → setCompletionAct(items[0]) → користувач знову бачить cancelled act,
    // не може клацнути «Сформувати акт» бо вже є запис у стані.
    // Узгоджено з createFromWorkOrder line 120 (status: { not: CANCELLED }).
    const where = {
      orgId,
      deletedAt: null,
      status: { not: CompletionActStatus.CANCELLED },
      ...(workOrderId ? { workOrderId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.completionAct.findMany({
        where,
        include: {
          workOrder: {
            select: {
              number: true,
              counterparty: { select: { firstName: true, lastName: true, companyName: true } },
              vehicle: { select: { make: true, model: true, licensePlate: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.completionAct.count({ where }),
    ]);
    return { items: items.map(item => this.toDto(item)), total };
  }

  async findOne(orgId: string, id: string): Promise<CompletionActResponseDto> {
    const item = await this.prisma.completionAct.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        workOrder: {
          select: {
            number: true,
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
            vehicle: { select: { make: true, model: true, licensePlate: true } },
            // narrow projection: buildLines() use лише normoHours/price/amount/workId + work.name (lines)
            // та quantity/price/amount/goodId + good.name (parts). Раніше include тягнув orgId/branchId/
            // workOrderId/sortOrder/costPrice/description/deletedAt etc. per row × 500 take = багато зайвого.
            lines: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 500,
              select: {
                normoHours: true,
                price: true,
                amount: true,
                workId: true,
                work: { select: { name: true } },
              },
            },
            parts: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 500,
              select: {
                quantity: true,
                price: true,
                amount: true,
                goodId: true,
                good: { select: { name: true, unit: true } },
              },
            },
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Акт не знайдено');
    const lines = this.buildLines(item.workOrder);
    return this.toDto(item, lines);
  }

  async createFromWorkOrder(orgId: string, workOrderId: string): Promise<CompletionActResponseDto> {
    // Run WO fetch + duplicate check in parallel — saves one sequential DB round-trip
    const [wo, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          lines: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { work: { select: { name: true } } },
            take: 500,
          },
          parts: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { good: { select: { name: true, unit: true } } },
            take: 500,
          },
        },
      }),
      this.prisma.completionAct.findFirst({
        where: {
          orgId,
          workOrderId,
          deletedAt: null,
          status: { not: CompletionActStatus.CANCELLED },
        },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!['COMPLETED', 'INVOICED'].includes(wo.status)) {
      throw new BadRequestException('Акт можна сформувати лише для завершеного наряду');
    }
    if (existing) throw new BadRequestException('Для цього наряду вже існує активний акт');

    const number = await this.docNumbers.next(orgId, 'COMPLETION_ACT');

    const act = await this.prisma.completionAct.create({
      data: { orgId, workOrderId, number, status: CompletionActStatus.DRAFT },
      include: {
        workOrder: {
          select: {
            number: true,
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
            vehicle: { select: { make: true, model: true, licensePlate: true } },
          },
        },
      },
    });

    const lines = this.buildLines(wo);
    return this.toDto(act, lines);
  }

  async sign(
    orgId: string,
    id: string,
    dto: SignCompletionActDto,
  ): Promise<CompletionActResponseDto> {
    let workOrderId: string | null = null;

    await this.prisma.$transaction(
      async tx => {
        const act = await tx.completionAct.findFirst({
          where: { id, orgId, deletedAt: null },
          include: { workOrder: { select: { id: true, status: true } } },
        });
        if (!act) throw new NotFoundException('Акт не знайдено');
        if (act.status !== CompletionActStatus.DRAFT) {
          throw new BadRequestException('Підписати можна лише чернетку акту');
        }

        await tx.completionAct.update({
          where: { id, orgId },
          data: {
            status: CompletionActStatus.SIGNED,
            signedAt: new Date(),
            signedBy: dto.signedBy ?? null,
            clientPhone: dto.clientPhone ?? null,
            notes: dto.notes ?? null,
          },
        });

        if (act.workOrder?.status === 'COMPLETED') {
          await tx.workOrder.update({
            where: { id: act.workOrder.id, orgId },
            data: { status: 'INVOICED' },
          });
        }
        workOrderId = act.workOrder?.id ?? null;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #130: explicit 5s timeout

    if (workOrderId) {
      try {
        await this.invoices.createFromWorkOrder(orgId, workOrderId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('вже існує активний рахунок')) {
          this.logger.warn(`Auto-invoice failed for act ${id}: ${msg}`);
        }
      }
    }

    return this.findOne(orgId, id);
  }

  async cancel(orgId: string, id: string): Promise<void> {
    // sto-optimize: status-guarded soft-delete з narrow `select: { status: true }`
    // замість full row read. -50-80% wire payload на guard read. Race-safe оскільки
    // status check + update happen sequentially (race window unchanged from prior code).
    const act = await this.prisma.completionAct.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!act) throw new NotFoundException('Акт не знайдено');
    if (act.status === CompletionActStatus.SIGNED) {
      throw new BadRequestException('Підписаний акт не можна скасувати');
    }
    await this.prisma.completionAct.update({
      where: { id, orgId },
      data: { status: CompletionActStatus.CANCELLED },
    });
  }

  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    // sto-optimize: ОДИН act read замість findOne + окремий workOrder query.
    // findOne повертав workOrder.counterparty (firstName/lastName/companyName) і
    // workOrder.vehicle — але БЕЗ phone/actualAddress (потрібних для PDF party block).
    // Раніше: act findOne + повторний workOrder findFirst для phone/address = 2 RTT
    // окремими запитами, тоді як можна було розширити include у findOne. Тепер
    // org + act-with-full-cp/vehicle йдуть паралельно у Promise.all (act read
    // одночасно завантажує phone/address — без додаткового RTT).
    const [org, act] = await Promise.all([
      this.prisma.organisation.findFirst({
        where: { id: orgId },
        select: { name: true },
      }),
      this.prisma.completionAct.findFirst({
        where: { id, orgId, deletedAt: null },
        include: {
          workOrder: {
            select: {
              number: true,
              counterparty: {
                select: {
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  phone: true,
                  actualAddress: true,
                },
              },
              vehicle: { select: { make: true, model: true, licensePlate: true } },
              lines: {
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
                take: 500,
                select: {
                  normoHours: true,
                  price: true,
                  amount: true,
                  workId: true,
                  work: { select: { name: true } },
                },
              },
              parts: {
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
                take: 500,
                select: {
                  quantity: true,
                  price: true,
                  amount: true,
                  goodId: true,
                  good: { select: { name: true, unit: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    if (!act) throw new NotFoundException('Акт не знайдено');

    const cp = act.workOrder?.counterparty;
    const cpName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || 'Клієнт';
    const vehicleLabel = formatVehicleLabel(act.workOrder?.vehicle);

    const builtLines = this.buildLines(act.workOrder);
    const total = builtLines.reduce((s, l) => s + l.amount, 0);

    return this.pdf.generateCompletionActPdf({
      org: { name: org?.name ?? 'СТО', edrpou: null, address: null },
      counterparty: { name: cpName, phone: cp?.phone, address: cp?.actualAddress },
      vehicleLabel,
      number: act.number,
      date: act.createdAt,
      signedAt: act.signedAt,
      signedBy: act.signedBy,
      lines: builtLines.map(l => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      })),
      total,
      notes: act.notes,
    });
  }

  private buildLines(
    wo:
      | {
          lines: Array<{
            normoHours: number;
            price: import('@prisma/client').Prisma.Decimal;
            amount: import('@prisma/client').Prisma.Decimal;
            workId: string;
            work: { name: string } | null;
          }>;
          parts: Array<{
            quantity: number;
            price: import('@prisma/client').Prisma.Decimal;
            amount: import('@prisma/client').Prisma.Decimal;
            goodId: string;
            good: { name: string; unit: string } | null;
          }>;
        }
      | null
      | undefined,
  ): CompletionActLineDto[] {
    if (!wo) return [];
    const lines: CompletionActLineDto[] = [];
    for (const l of wo.lines) {
      lines.push({
        description: l.work?.name ?? 'Робота',
        quantity: l.normoHours,
        unitPrice: Number(l.price),
        amount: Number(l.amount),
        workId: l.workId,
      });
    }
    for (const p of wo.parts) {
      lines.push({
        description: p.good?.name ?? 'Запчастина',
        quantity: p.quantity,
        unitPrice: Number(p.price),
        amount: Number(p.amount),
        goodId: p.goodId,
      });
    }
    return lines;
  }

  private toDto(
    act: {
      id: string;
      orgId: string;
      workOrderId: string;
      number: string;
      status: CompletionActStatus;
      signedAt: Date | null;
      signedBy: string | null;
      clientPhone: string | null;
      notes: string | null;
      createdAt: Date;
      updatedAt: Date;
      workOrder: {
        number: string;
        counterparty: {
          firstName: string | null;
          lastName: string | null;
          companyName: string | null;
        } | null;
        vehicle: { make: string; model: string; licensePlate: string | null } | null;
      } | null;
    },
    lines?: CompletionActLineDto[],
  ): CompletionActResponseDto {
    const cp = act.workOrder?.counterparty;
    const counterpartyName =
      formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
    const vehicleLabel = formatVehicleLabel(act.workOrder?.vehicle) || undefined;
    return {
      id: act.id,
      orgId: act.orgId,
      workOrderId: act.workOrderId,
      number: act.number,
      status: act.status,
      signedAt: act.signedAt,
      signedBy: act.signedBy,
      clientPhone: act.clientPhone,
      notes: act.notes,
      workOrderNumber: act.workOrder?.number,
      counterpartyName,
      vehicleLabel,
      ...(lines !== undefined ? { lines } : {}),
      createdAt: act.createdAt,
      updatedAt: act.updatedAt,
    };
  }
}
