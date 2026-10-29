import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AutomationDocumentType, Prisma } from '@prisma/client';
import { AUTOMATION_STATUS_LABELS, type AutomationVariableKey } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { trimTrailingSlashes } from '../../common/utils/trim-trailing-slashes';
import { formatKyivDate, formatKyivTime, formatMoneyUah } from './automation-text';

/** Клієнт-одержувач повідомлення (BR-AUT-010, 012). */
export interface AutomationClient {
  /** null — онлайн-запис: контрагента немає, лише ім'я й телефон заявки. */
  counterpartyId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  noServiceMessages: boolean;
  marketingConsent: boolean;
}

/**
 * Дані документа події, потрібні умовам, діям і змінним шаблону. Читаються ОДИН раз на подію —
 * одним запитом на тип документа (плюс філія й організація для змінних).
 */
export interface DocumentContext {
  documentType: AutomationDocumentType;
  documentId: string;
  status: string | null;
  /** Філія документа для умови «філія» (BR-AUT-003); null — у документа своєї філії немає. */
  branchId: string | null;
  /** Філія для каналів повідомлень і `{{branchName}}` — документа або перша філія організації. */
  messageBranchId: string | null;
  amount: number | null;
  repairCategory: string | null;
  priority: string | null;
  client: AutomationClient | null;
  /** «Відповідальні з документа» в порядку пріоритету (BR-AUT-020); автор — окремо, ліниво. */
  responsibleIds: string[];
  /** Чи «відповідальний» — автор документа (ініціатор події «створено»), а не поле документа. */
  responsibleIsAuthor: boolean;
  workOrderId: string | null;
  vehicleId: string | null;
  counterpartyId: string | null;
  /** Змінні шаблону з даних документа, організації й філії (без момент-залежних date/time). */
  vars: Partial<Record<AutomationVariableKey, string>>;
}

const CP_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  companyName: true,
  phone: true,
  email: true,
  noServiceMessages: true,
  marketingConsent: true,
} satisfies Prisma.CounterpartySelect;

type CpRow = Prisma.CounterpartyGetPayload<{ select: typeof CP_SELECT }>;

const VEHICLE_SELECT = {
  make: true,
  model: true,
  licensePlate: true,
} satisfies Prisma.VehicleSelect;

type VehicleRow = { make: string; model: string; licensePlate: string | null } | null;

const cpName = (c: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}) => c.companyName || [c.lastName, c.firstName].filter(Boolean).join(' ');

const toClient = (c: CpRow): AutomationClient => ({
  counterpartyId: c.id,
  name: cpName(c),
  phone: c.phone,
  email: c.email,
  noServiceMessages: c.noServiceMessages,
  marketingConsent: c.marketingConsent,
});

const vehicleVars = (v: VehicleRow): Partial<Record<AutomationVariableKey, string>> =>
  v
    ? {
        vehicle: `${v.make} ${v.model}${v.licensePlate ? ` (${v.licensePlate})` : ''}`.trim(),
        vehiclePlate: v.licensePlate ?? '',
      }
    : {};

const clientVars = (c: AutomationClient | null): Partial<Record<AutomationVariableKey, string>> =>
  c ? { clientName: c.name, clientPhone: c.phone ?? '' } : {};

const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : Number(d);

/** Відсутній документ — подію пропускаємо (видалено між зміною й обробкою). */
type Partial0 = Omit<DocumentContext, 'documentType' | 'documentId' | 'messageBranchId'> | null;

const EMPTY = {
  amount: null,
  repairCategory: null,
  priority: null,
  client: null,
  responsibleIds: [] as string[],
  responsibleIsAuthor: true,
  workOrderId: null,
  vehicleId: null,
  counterpartyId: null,
};

@Injectable()
export class AutomationContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Контекст документа події; `null` — документа немає (видалено) — правила не виконуються. */
  async load(
    orgId: string,
    documentType: AutomationDocumentType,
    documentId: string,
    now: Date = new Date(),
  ): Promise<DocumentContext | null> {
    const doc = await this.loadDocument(orgId, documentType, documentId, now);
    if (!doc) return null;
    const [branch, org] = await Promise.all([
      this.prisma.garageBranch.findFirst({
        where: doc.branchId ? { id: doc.branchId, orgId } : { orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.organisation.findFirst({ where: { id: orgId }, select: { phone: true } }),
    ]);
    const statusLabel = doc.status
      ? (AUTOMATION_STATUS_LABELS[documentType][doc.status] ?? doc.status)
      : '';
    return {
      ...doc,
      documentType,
      documentId,
      messageBranchId: branch?.id ?? null,
      vars: {
        ...doc.vars,
        status: statusLabel,
        branchName: branch?.name ?? '',
        branchPhone: org?.phone ?? '',
      },
    };
  }

  /**
   * Автор документа — ініціатор найранішої події «створено» в outbox (BR-AUT-020). Документ,
   * створений системою або до появи outbox, автора не має.
   */
  async authorOf(
    orgId: string,
    documentType: AutomationDocumentType,
    documentId: string,
  ): Promise<string | null> {
    const created = await this.prisma.domainEvent.findFirst({
      where: { orgId, documentType, documentId, kind: 'CREATED', deletedAt: null },
      orderBy: { occurredAt: 'asc' },
      select: { actorId: true },
    });
    return created?.actorId ?? null;
  }

  private estimateLink(token: string | null, expiresAt: Date | null, now: Date): string {
    const publicUrl = this.config.get<string>('WEB_PUBLIC_URL');
    if (!token || !publicUrl) return '';
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return '';
    return `${trimTrailingSlashes(publicUrl)}/estimate/${token}`;
  }

  private async loadDocument(
    orgId: string,
    type: AutomationDocumentType,
    id: string,
    now: Date,
  ): Promise<Partial0> {
    const where = { id, orgId, deletedAt: null };
    switch (type) {
      case 'WORK_ORDER': {
        const wo = await this.prisma.workOrder.findFirst({
          where,
          select: {
            number: true,
            status: true,
            branchId: true,
            totalAmount: true,
            repairCategory: true,
            priority: true,
            vehicleId: true,
            counterpartyId: true,
            shareToken: true,
            shareTokenExpiresAt: true,
            counterparty: { select: CP_SELECT },
            vehicle: { select: VEHICLE_SELECT },
            lines: {
              where: { deletedAt: null },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { employeeId: true, assistEmployees: { select: { employeeId: true } } },
              take: 200,
            },
          },
        });
        if (!wo) return null;
        const client = toClient(wo.counterparty);
        // Виконавці рядків робіт (основні, далі помічники) — порядок рядків; без повторів.
        const executors = [
          ...new Set([
            ...wo.lines.map(l => l.employeeId),
            ...wo.lines.flatMap(l => l.assistEmployees.map(a => a.employeeId)),
          ]),
        ];
        return {
          ...EMPTY,
          status: wo.status,
          branchId: wo.branchId,
          amount: num(wo.totalAmount),
          repairCategory: wo.repairCategory,
          priority: wo.priority,
          client,
          responsibleIds: executors,
          responsibleIsAuthor: false,
          workOrderId: id,
          vehicleId: wo.vehicleId,
          counterpartyId: wo.counterpartyId,
          vars: {
            documentNumber: wo.number,
            totalAmount: formatMoneyUah(Number(wo.totalAmount)),
            estimateLink: this.estimateLink(wo.shareToken, wo.shareTokenExpiresAt, now),
            ...clientVars(client),
            ...vehicleVars(wo.vehicle),
          },
        };
      }
      case 'INVOICE': {
        const inv = await this.prisma.invoice.findFirst({
          where,
          select: {
            number: true,
            status: true,
            amount: true,
            counterpartyId: true,
            workOrderId: true,
            counterparty: { select: CP_SELECT },
            workOrder: {
              select: { branchId: true, vehicleId: true, vehicle: { select: VEHICLE_SELECT } },
            },
          },
        });
        if (!inv) return null;
        const client = toClient(inv.counterparty);
        return {
          ...EMPTY,
          status: inv.status,
          branchId: inv.workOrder?.branchId ?? null,
          amount: num(inv.amount),
          client,
          workOrderId: inv.workOrderId,
          vehicleId: inv.workOrder?.vehicleId ?? null,
          counterpartyId: inv.counterpartyId,
          vars: {
            documentNumber: inv.number,
            totalAmount: formatMoneyUah(Number(inv.amount)),
            ...clientVars(client),
            ...vehicleVars(inv.workOrder?.vehicle ?? null),
          },
        };
      }
      case 'PAYMENT': {
        // Оплата не має soft delete — лише сторно (`reversedAt`).
        const p = await this.prisma.payment.findFirst({
          where: { id, orgId },
          select: {
            amount: true,
            reversedAt: true,
            counterpartyId: true,
            workOrderId: true,
            counterparty: { select: CP_SELECT },
            workOrder: { select: { branchId: true } },
          },
        });
        if (!p) return null;
        const client = toClient(p.counterparty);
        return {
          ...EMPTY,
          status: p.reversedAt ? 'REVERSED' : 'ACTIVE',
          branchId: p.workOrder?.branchId ?? null,
          amount: num(p.amount),
          client,
          workOrderId: p.workOrderId,
          counterpartyId: p.counterpartyId,
          vars: { totalAmount: formatMoneyUah(Number(p.amount)), ...clientVars(client) },
        };
      }
      case 'BOOKING': {
        const b = await this.prisma.bookingRequest.findFirst({
          where,
          select: {
            status: true,
            branchId: true,
            clientName: true,
            clientPhone: true,
            requestedDate: true,
          },
        });
        if (!b) return null;
        // Онлайн-запис без контрагента: згоди не перевіряються, маркетингу — ні (BR-AUT-010, 012).
        const client: AutomationClient = {
          counterpartyId: null,
          name: b.clientName,
          phone: b.clientPhone || null,
          email: null,
          noServiceMessages: false,
          marketingConsent: false,
        };
        return {
          ...EMPTY,
          status: b.status,
          branchId: b.branchId,
          client,
          vars: {
            ...clientVars(client),
            visitDate: formatKyivDate(b.requestedDate),
            visitTime: formatKyivTime(b.requestedDate),
          },
        };
      }
      case 'PURCHASE_ORDER': {
        const po = await this.prisma.purchaseOrder.findFirst({
          where,
          select: {
            number: true,
            status: true,
            totalAmount: true,
            supplierId: true,
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { branchId: true } },
          },
        });
        if (!po) return null;
        return {
          ...EMPTY,
          status: po.status,
          branchId: po.warehouse.branchId,
          amount: num(po.totalAmount),
          counterpartyId: po.supplierId,
          vars: {
            documentNumber: po.number,
            supplierName: cpName(po.supplier),
            totalAmount: formatMoneyUah(Number(po.totalAmount)),
          },
        };
      }
      case 'STOCK_DOCUMENT': {
        const sd = await this.prisma.stockDocument.findFirst({
          where,
          select: { number: true, status: true, branchId: true },
        });
        if (!sd) return null;
        return {
          ...EMPTY,
          status: sd.status,
          branchId: sd.branchId,
          vars: { documentNumber: sd.number },
        };
      }
      case 'SUPPLIER_PAYMENT': {
        const sp = await this.prisma.supplierPayment.findFirst({
          where,
          select: {
            number: true,
            status: true,
            amount: true,
            supplierId: true,
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
          },
        });
        if (!sp) return null;
        return {
          ...EMPTY,
          status: sp.status,
          branchId: null,
          amount: num(sp.amount),
          counterpartyId: sp.supplierId,
          vars: {
            documentNumber: sp.number,
            supplierName: cpName(sp.supplier),
            totalAmount: formatMoneyUah(Number(sp.amount)),
          },
        };
      }
      case 'SUPPLIER_RETURN': {
        const sr = await this.prisma.supplierReturn.findFirst({
          where,
          select: {
            number: true,
            status: true,
            totalAmount: true,
            supplierId: true,
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { branchId: true } },
          },
        });
        if (!sr) return null;
        return {
          ...EMPTY,
          status: sr.status,
          branchId: sr.warehouse.branchId,
          amount: num(sr.totalAmount),
          counterpartyId: sr.supplierId,
          vars: {
            documentNumber: sr.number,
            supplierName: cpName(sr.supplier),
            totalAmount: formatMoneyUah(Number(sr.totalAmount)),
          },
        };
      }
      case 'TASK': {
        const t = await this.prisma.task.findFirst({
          where,
          select: {
            title: true,
            status: true,
            priority: true,
            assigneeId: true,
            workOrderId: true,
            vehicleId: true,
            counterpartyId: true,
            assignee: { select: { firstName: true, lastName: true } },
            workOrder: { select: { branchId: true } },
          },
        });
        if (!t) return null;
        return {
          ...EMPTY,
          status: t.status,
          branchId: t.workOrder?.branchId ?? null,
          priority: t.priority,
          responsibleIds: [t.assigneeId],
          responsibleIsAuthor: false,
          workOrderId: t.workOrderId,
          vehicleId: t.vehicleId,
          counterpartyId: t.counterpartyId,
          vars: {
            taskTitle: t.title,
            assigneeName: [t.assignee.lastName, t.assignee.firstName].filter(Boolean).join(' '),
          },
        };
      }
      default: {
        const _exhaustive: never = type;
        return _exhaustive;
      }
    }
  }
}
