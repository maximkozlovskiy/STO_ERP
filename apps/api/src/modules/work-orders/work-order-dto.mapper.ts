import type { Prisma, WorkOrderStatus, WorkOrderPriority, RepairCategory } from '@prisma/client';
import { formatPersonName } from '@sto/shared';
import { safeCoeff } from '../../common/utils/math';
import type {
  WorkOrderResponseDto,
  WorkOrderLineResponseDto,
  WorkOrderPartResponseDto,
} from './work-orders.dto';

/**
 * Чисті DTO-мапери WorkOrder-агрегату (виділено з work-orders.service, TD3-декомпозиція).
 * Жодних `this`/DI/Prisma-запитів — лише row→DTO трансформація. Сервіс делегує сюди через
 * тонкі приватні обгортки, тож усі наявні виклики `this.toDto(...)` лишаються незмінними, а
 * специ сервісу покривають ці функції наскрізь (вивід ідентичний до/після виділення).
 */

// §2.1 Auth: costPrice видимий лише цим ролям (fail-closed для решти).
const COST_PRICE_VISIBLE_ROLES = new Set<string>(['OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT']);
const canSeeCostPrice = (role?: string | null): boolean =>
  !!role && COST_PRICE_VISIBLE_ROLES.has(role);

export function mapWorkOrderToDto(wo: {
  id: string;
  orgId: string;
  number: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  repairCategory: RepairCategory | null;
  branchId: string;
  vehicleId: string;
  counterpartyId: string;
  contractId?: string | null;
  liftId?: string | null;
  description: string | null;
  inMileage: number | null;
  outMileage: number | null;
  plannedAt: Date | null;
  dueDate: Date | null;
  plannedHours?: number | null;
  actualHours?: number | null;
  completedAt: Date | null;
  clientApproval: boolean;
  totalLabor: Prisma.Decimal;
  totalActualLabor?: Prisma.Decimal | null;
  totalParts: Prisma.Decimal;
  totalNet?: Prisma.Decimal | null;
  totalAmount: Prisma.Decimal;
  totalVat?: Prisma.Decimal | null;
  paidAmount: Prisma.Decimal | null;
  currencyId?: string | null;
  totalAmountBase?: Prisma.Decimal | null;
  rateUsed?: Prisma.Decimal | null;
  currency?: { code: string } | null;
  documentDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  branch?: { name: string } | null;
  vehicle?: { make: string; model: string; licensePlate: string | null } | null;
  counterparty?: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null;
  contract?: { id: string; number: string } | null;
  lift?: { name: string } | null;
  calendarSlots?: { startAt: Date; endAt: Date; lift: { name: string } | null }[];
  _count?: { warranties?: number } | null;
}): WorkOrderResponseDto {
  const cp = wo.counterparty;
  const cpName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
  return {
    id: wo.id,
    orgId: wo.orgId,
    number: wo.number,
    status: wo.status,
    priority: wo.priority,
    repairCategory: wo.repairCategory ?? null,
    branchId: wo.branchId,
    branchName: wo.branch?.name,
    vehicleId: wo.vehicleId,
    vehicleSummary: wo.vehicle
      ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
      : undefined,
    counterpartyId: wo.counterpartyId,
    counterpartyName: cpName,
    contractId: wo.contractId ?? null,
    contractNumber: wo.contract?.number ?? null,
    liftId: wo.liftId ?? null,
    liftName: wo.lift?.name ?? null,
    description: wo.description ?? null,
    inMileage: wo.inMileage ?? null,
    outMileage: wo.outMileage ?? null,
    plannedAt: wo.plannedAt instanceof Date ? wo.plannedAt.toISOString() : (wo.plannedAt ?? null),
    dueDate: wo.dueDate instanceof Date ? wo.dueDate.toISOString() : (wo.dueDate ?? null),
    plannedHours: wo.plannedHours ?? null,
    actualHours: wo.actualHours ?? null,
    completedAt:
      wo.completedAt instanceof Date ? wo.completedAt.toISOString() : (wo.completedAt ?? null),
    clientApproval: wo.clientApproval,
    totalLabor: Number(wo.totalLabor),
    totalActualLabor: Number(wo.totalActualLabor ?? 0),
    totalParts: Number(wo.totalParts),
    // totalNet відсутній лише у вузьких select-ах без нього — тоді сума без ПДВ невідома, і
    // чесніше показати суму наряду, ніж нуль.
    totalNet: Number(wo.totalNet ?? wo.totalAmount),
    totalAmount: Number(wo.totalAmount),
    totalVat: Number(wo.totalVat ?? 0),
    paidAmount: wo.paidAmount != null ? Number(wo.paidAmount) : 0,
    currencyId: wo.currencyId ?? null,
    currencyCode: wo.currency?.code ?? null,
    totalAmountBase: wo.totalAmountBase != null ? Number(wo.totalAmountBase) : null,
    rateUsed: wo.rateUsed != null ? Number(wo.rateUsed) : null,
    documentDate: wo.documentDate ? wo.documentDate.toISOString().slice(0, 10) : null,
    createdAt: wo.createdAt instanceof Date ? wo.createdAt.toISOString() : wo.createdAt,
    updatedAt: wo.updatedAt instanceof Date ? wo.updatedAt.toISOString() : wo.updatedAt,
    hasActiveWarranty: (wo._count?.warranties ?? 0) > 0,
    slotStartAt:
      wo.calendarSlots?.[0]?.startAt instanceof Date
        ? wo.calendarSlots[0].startAt.toISOString()
        : (wo.calendarSlots?.[0]?.startAt ?? null),
    slotEndAt:
      wo.calendarSlots?.[0]?.endAt instanceof Date
        ? wo.calendarSlots[0].endAt.toISOString()
        : (wo.calendarSlots?.[0]?.endAt ?? null),
    slotLiftName: wo.calendarSlots?.[0]?.lift?.name ?? null,
    deletedAt: wo.deletedAt instanceof Date ? wo.deletedAt.toISOString() : (wo.deletedAt ?? null),
  };
}

export function mapWorkOrderLineToDto(line: {
  id: string;
  workOrderId: string;
  workId: string;
  employeeId: string;
  liftId: string | null;
  normoHours: number;
  actualHours: number | null;
  price: Prisma.Decimal;
  amount: Prisma.Decimal;
  notes: string | null;
  createdAt: Date;
  work?: { name: string } | null;
  employee?: { firstName: string; lastName: string } | null;
}): WorkOrderLineResponseDto {
  return {
    id: line.id,
    workOrderId: line.workOrderId,
    workId: line.workId,
    workName: line.work?.name,
    employeeId: line.employeeId,
    employeeName: line.employee
      ? formatPersonName(line.employee.lastName, line.employee.firstName) || undefined
      : undefined,
    liftId: line.liftId ?? null,
    normoHours: line.normoHours,
    actualHours: line.actualHours ?? null,
    price: Number(line.price),
    amount: Number(line.amount),
    notes: line.notes ?? null,
    createdAt: line.createdAt instanceof Date ? line.createdAt.toISOString() : line.createdAt,
  };
}

export function mapWorkOrderPartToDto(
  part: {
    id: string;
    workOrderId: string;
    goodId: string;
    warehouseId: string;
    quantity: number;
    price: Prisma.Decimal;
    amount: Prisma.Decimal;
    batchCostPrice?: Prisma.Decimal | null;
    unitOfMeasureId?: string | null;
    createdAt: Date;
    good?: {
      name: string;
      internalCode?: string | null;
      sku?: string | null;
      unit: string;
      unitOfMeasure: { shortName: string; coefficient: number } | null;
      brand?: { name: string } | null;
    } | null;
    // Populated when unitOfMeasureId is set — per-good GoodUoM record (id not needed for DTO).
    goodUoM?: { coefficient: number; unitOfMeasure: { shortName: string } } | null;
  },
  // §2.1 Auth: костПрайс маскується для ролей не в COST_PRICE_VISIBLE_ROLES.
  // Default = undefined → не показувати (fail-closed). Усі mutation-endpoints
  // (findOne / addPart / updatePart) приймають userRole і передають сюди —
  // консистентна поведінка: OWNER/ADMIN/STOREKEEPER/ACCOUNTANT бачать costPrice
  // після додавання/редагування запчастини; MECHANIC/RECEPTIONIST/CLIENT — ні.
  userRole?: string,
): WorkOrderPartResponseDto {
  // If a specific GoodUoM was selected — use its shortName/coefficient.
  // Fallback to the good's base unit.
  const selectedUoM = part.goodUoM;
  const baseUoM = part.good?.unitOfMeasure;
  return {
    id: part.id,
    workOrderId: part.workOrderId,
    goodId: part.goodId,
    goodName: part.good?.name,
    goodInternalCode: part.good?.internalCode ?? null,
    goodSku: part.good?.sku ?? null,
    goodBrandName: part.good?.brand?.name ?? null,
    unitOfMeasureId: part.unitOfMeasureId ?? null,
    unitShortName: selectedUoM?.unitOfMeasure.shortName ?? baseUoM?.shortName ?? part.good?.unit,
    // safeCoeff() guards legacy/seed coefficient=0 — множник display↔base (qty_base = qty * coefficient).
    coefficient: safeCoeff(selectedUoM?.coefficient ?? baseUoM?.coefficient),
    warehouseId: part.warehouseId,
    quantity: part.quantity,
    // §2.1 Auth: маскуємо costPrice для MECHANIC/RECEPTIONIST/etc.
    costPrice: canSeeCostPrice(userRole)
      ? part.batchCostPrice != null
        ? Number(part.batchCostPrice)
        : null
      : undefined,
    price: Number(part.price),
    amount: Number(part.amount),
    createdAt: part.createdAt instanceof Date ? part.createdAt.toISOString() : part.createdAt,
  };
}
