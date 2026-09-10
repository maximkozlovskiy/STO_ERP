import type { Warehouse, Unit, Employee } from '@/hooks/useReferenceData';

export type { Warehouse, Unit, Employee };

export interface LocalLine {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  workId: string;
  workName: string;
  employeeId: string;
  normoHours: string;
  actualHours: string;
  price: string;
}

export interface LocalPart {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  goodId: string;
  goodName: string;
  goodInternalCode?: string | null;
  goodSku?: string | null;
  goodBrandName?: string | null;
  warehouseId: string;
  quantity: string;
  costPrice?: number | null;
  price: string;
  unitOfMeasureId: string;
  unitShortName: string;
}

// Форма-стан модалки наряду. Єдине джерело правди для CreateWorkOrderModal.useState<WorkOrderFormState>
// та WorksTable (delete-handler мутує через setForm). Раніше дублювався у WorksTable — drift-ризик.
export interface WorkOrderFormState {
  branchId: string;
  vehicleId: string;
  counterpartyId: string;
  contractId: string;
  liftId: string;
  description: string;
  priority: string;
  repairCategory: string;
  documentDate: string;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: string;
  actualHours: string;
}
